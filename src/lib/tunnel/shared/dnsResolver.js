import { resolveDomain } from "@/lib/network/dnsResolver";

/**
 * Force public DNS to bypass OS negative cache (mDNSResponder holds NXDOMAIN)
 * with multi-tier fallback (Google/Cloudflare/AliDNS UDP + DoH + OS resolver)
 */
export async function resolveDns(hostname, timeoutMs = 2000) {
  try {
    const ip = await resolveDomain(hostname, { timeoutMs, isMitmBypass: false });
    return !!ip;
  } catch {
    return false;
  }
}
