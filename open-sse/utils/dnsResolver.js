const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const { promisify } = require("node:util");

const DEFAULT_DNS_SERVERS = ["8.8.8.8", "1.1.1.1", "8.8.4.4", "1.0.0.1", "223.5.5.5"];
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const MITM_BYPASS_HOSTS = new Set([
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "runtime.us-east-1.kiro.dev",
  "api2.cursor.sh",
]);

const DNS_CACHE = new Map();

function isMitmInterceptedHost(hostname) {
  if (!hostname) return false;
  const lower = String(hostname).toLowerCase();
  for (const host of MITM_BYPASS_HOSTS) {
    if (lower === host || lower.endsWith(`.${host}`)) return true;
  }
  return false;
}

function getDnsServers() {
  if (process.env.DNS_SERVERS) {
    const parsed = process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_DNS_SERVERS;
}

function getCacheTtl() {
  if (process.env.DNS_CACHE_TTL_MS) {
    const ttl = parseInt(process.env.DNS_CACHE_TTL_MS, 10);
    if (!Number.isNaN(ttl) && ttl > 0) return ttl;
  }
  return DEFAULT_CACHE_TTL_MS;
}

function isDohEnabled() {
  return process.env.DNS_ENABLE_DOH !== "false" && process.env.DNS_ENABLE_DOH !== "0";
}

function withTimeout(promise, ms, label = "Operation") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

async function resolveViaUdp(hostname, { family = 4, timeoutMs = 1500 } = {}) {
  const servers = getDnsServers();
  const resolver = new dns.Resolver();
  resolver.setServers(servers);

  const fn = family === 6
    ? promisify(resolver.resolve6.bind(resolver))
    : promisify(resolver.resolve4.bind(resolver));

  const addresses = await withTimeout(fn(hostname), timeoutMs, `UDP DNS (${servers.join(",")})`);
  if (addresses && addresses.length > 0) {
    return addresses[0];
  }
  return null;
}

const DOH_PROVIDERS = [
  {
    name: "Google DoH",
    ip: "8.8.8.8",
    host: "dns.google",
    path: (name, type) => `/resolve?name=${encodeURIComponent(name)}&type=${type}`,
    headers: { Host: "dns.google", Accept: "application/json" },
    extractIp: (data) => {
      if (data && data.Status === 0 && Array.isArray(data.Answer)) {
        const match = data.Answer.find((a) => (a.type === 1 || a.type === 28) && a.data);
        return match ? match.data : null;
      }
      return null;
    },
  },
  {
    name: "Cloudflare DoH",
    ip: "1.1.1.1",
    host: "cloudflare-dns.com",
    path: (name, type) => `/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    headers: { Host: "cloudflare-dns.com", Accept: "application/dns-json" },
    extractIp: (data) => {
      if (data && data.Status === 0 && Array.isArray(data.Answer)) {
        const match = data.Answer.find((a) => (a.type === 1 || a.type === 28) && a.data);
        return match ? match.data : null;
      }
      return null;
    },
  },
  {
    name: "AliDNS DoH",
    ip: "223.5.5.5",
    host: "dns.alidns.com",
    path: (name, type) => `/resolve?name=${encodeURIComponent(name)}&type=${type}`,
    headers: { Host: "dns.alidns.com", Accept: "application/json" },
    extractIp: (data) => {
      if (data && data.Status === 0 && Array.isArray(data.Answer)) {
        const match = data.Answer.find((a) => (a.type === 1 || a.type === 28) && a.data);
        return match ? match.data : null;
      }
      return null;
    },
  },
];

function queryDohProvider(provider, hostname, type = "A", timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: provider.ip,
      port: 443,
      path: provider.path(hostname, type),
      method: "GET",
      headers: provider.headers,
      servername: provider.host,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`${provider.name} returned status ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const ip = provider.extractIp(parsed);
          if (ip) resolve(ip);
          else reject(new Error(`${provider.name} did not return valid IP address in Answer`));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`${provider.name} timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

async function resolveViaDoh(hostname, { family = 4, timeoutMs = 2500 } = {}) {
  if (!isDohEnabled()) return null;
  const type = family === 6 ? "AAAA" : "A";
  for (const provider of DOH_PROVIDERS) {
    try {
      const ip = await queryDohProvider(provider, hostname, type, timeoutMs);
      if (ip) return ip;
    } catch {
      // try next DoH provider
    }
  }
  return null;
}

/**
 * Resilient multi-tier domain resolution
 * Tier 0: In-Memory TTL Cache
 * Tier 1: Public / Custom UDP DNS (Google, Cloudflare, AliDNS)
 * Tier 2: DNS-over-HTTPS (Google DoH -> Cloudflare DoH -> AliDNS DoH)
 * Tier 3: System DNS (only for non-MITM hosts)
 */
async function resolveDomain(hostname, options = {}) {
  if (!hostname || typeof hostname !== "string") return null;
  const target = hostname.trim();

  // If already an IP address, return immediately
  if (net.isIP(target)) {
    return target;
  }

  const bypassCache = options.bypassCache === true;
  const isMitm = options.isMitmBypass === true || isMitmInterceptedHost(target);
  const family = options.family === 6 ? 6 : 4;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const cacheKey = `${target}:${family}`;
  if (!bypassCache) {
    const cached = DNS_CACHE.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.ip;
    }
  }

  let resolvedIp = null;

  // Tier 1: Public UDP/TCP DNS
  try {
    resolvedIp = await resolveViaUdp(target, { family, timeoutMs });
  } catch {
    // UDP DNS failed or timed out, will proceed to DoH
  }

  // Tier 2: DoH Fallback (Google -> Cloudflare -> AliDNS)
  if (!resolvedIp) {
    try {
      resolvedIp = await resolveViaDoh(target, { family, timeoutMs });
    } catch {
      // DoH failed
    }
  }

  // Tier 3: System resolver fallback (ONLY for non-MITM hosts)
  if (!resolvedIp && !isMitm) {
    try {
      const res = await withTimeout(
        dns.promises.lookup(target, { family, all: false }),
        timeoutMs,
        "System DNS"
      );
      if (res && res.address) {
        resolvedIp = res.address;
      }
    } catch {
      // System lookup failed
    }
  }

  if (resolvedIp) {
    DNS_CACHE.set(cacheKey, {
      ip: resolvedIp,
      expiry: Date.now() + getCacheTtl(),
    });
    return resolvedIp;
  }

  if (isMitm) {
    console.warn(`[DNS] Failed to resolve MITM host ${target} via public DNS / DoH. Refusing system resolver to avoid 127.0.0.1 loop.`);
  }

  return null;
}

async function resolveRealIP(hostname, options = {}) {
  return resolveDomain(hostname, { ...options, isMitmBypass: true });
}

async function resolveTargetIP(hostname, options = {}) {
  const ip = await resolveDomain(hostname, { ...options, isMitmBypass: true });
  if (!ip) throw new Error(`[DNS] Failed to resolve ${hostname}`);
  return ip;
}

function clearDnsCache() {
  DNS_CACHE.clear();
}

function getDnsCacheSize() {
  return DNS_CACHE.size;
}

module.exports = {
  resolveDomain,
  resolveRealIP,
  resolveTargetIP,
  resolveViaUdp,
  resolveViaDoh,
  clearDnsCache,
  getDnsCacheSize,
  isMitmInterceptedHost,
  DEFAULT_DNS_SERVERS,
  MITM_BYPASS_HOSTS,
};
