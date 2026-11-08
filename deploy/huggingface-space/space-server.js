const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createHash, timingSafeEqual } = require("node:crypto");
const { createPersistence } = require("./persistence");

const publicPort = Number(process.env.PORT || 20128);
const appPort = 20129;
const routerApiKey = process.env.ROUTER_API_KEY;
const clineTokenHash = process.env.CLINE_HF_TOKEN_SHA256;
const persistence = createPersistence({
  dataDir: process.env.DATA_DIR || "/app/data",
  persistDir: process.env.NINE_ROUTER_PERSIST_DIR || "/app/persist",
});
let backupTimer;
let backupDelay;

function scheduleBackup() {
  clearTimeout(backupDelay);
  backupDelay = setTimeout(() => {
    persistence.backupNow().catch((error) => console.error("[Persistence] Backup failed:", error));
  }, 2000);
}

function isClineToken(authorization) {
  if (!routerApiKey || !/^[a-f\d]{64}$/i.test(clineTokenHash || "")) return false;
  const match = /^Bearer (\S+)$/i.exec(authorization || "");
  if (!match) return false;
  const expected = Buffer.from(clineTokenHash, "hex");
  const actual = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(actual, expected);
}

function upstreamHeaders(request) {
  const headers = { ...request.headers };
  // Hugging Face checks Authorization before forwarding private Space requests.
  // Cline sends its API key in that header, so a matching HF token can use the
  // 9router key stored in a Space Secret. X-API-Key remains available to clients
  // that can send two headers.
  const suppliedKey = headers["x-api-key"];
  const secretKey = request.url.startsWith("/v1/") && isClineToken(headers.authorization)
    ? routerApiKey
    : undefined;
  delete headers.authorization;
  delete headers["x-api-key"];
  // CLI machine tokens are only intended for calls from the local host. A
  // remote client must use its dashboard session for protected routes.
  delete headers["x-9r-cli-token"];
  // custom-server.js trusts forwarding headers from this loopback proxy. Stamp
  // them from the actual TCP peer so public clients cannot choose their IP.
  const peer = request.socket.remoteAddress || "unknown";
  headers["x-real-ip"] = peer;
  headers["x-forwarded-for"] = peer;
  delete headers["x-forwarded-host"];
  if (suppliedKey || secretKey) headers.authorization = `Bearer ${suppliedKey || secretKey}`;
  headers["x-forwarded-proto"] = "https";
  return headers;
}

function iframeSessionCookies(headers) {
  const cookies = headers["set-cookie"];
  if (!cookies) return headers;
  const list = Array.isArray(cookies) ? cookies : [cookies];
  return {
    ...headers,
    "set-cookie": list.map((cookie) => {
      if (!/^auth_token=/i.test(cookie)) return cookie;
      // The app runs in an hf.space iframe on huggingface.co. Its default Lax
      // cookie is not sent from that cross-site frame. Partition it for the
      // Hugging Face page while retaining Secure and HttpOnly.
      let updated = cookie
        .replace(/;\s*SameSite=(?:Strict|Lax|None)/gi, "")
        .replace(/;\s*Partitioned\b/gi, "");
      if (!/;\s*Secure\b/i.test(updated)) updated += "; Secure";
      return `${updated}; SameSite=None; Partitioned`;
    }),
  };
}

const server = http.createServer((request, response) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: appPort,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request),
    },
    (result) => {
      response.writeHead(result.statusCode, iframeSessionCookies(result.headers));
      result.pipe(response);
      if (result.statusCode < 400 && (request.method !== "GET" || request.url.startsWith("/callback"))) {
        result.on("end", scheduleBackup);
      }
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("9router is starting or unavailable");
  });
  request.pipe(upstream);
});

server.on("upgrade", (request, client, head) => {
  const upstream = net.connect(appPort, "127.0.0.1");
  upstream.on("connect", () => {
    const headers = upstreamHeaders(request);
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

try {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const candidates = [
      "/app/.next/server/chunks/9100.js",
      path.join(__dirname, ".next/server/chunks/9100.js"),
      path.join(__dirname, ".next-cli-build/server/chunks/9100.js")
    ];
    for (const cPath of candidates) {
      if (fs.existsSync(cPath)) {
        let code = fs.readFileSync(cPath, "utf8");
        if (code.includes("enableObservability:!1")) {
          code = code.replace(/enableObservability:!1/g, "enableObservability:!0");
          fs.writeFileSync(cPath, code, "utf8");
          console.log(`[SpacePatch] Enabled observability default in ${cPath}`);
        }
      }
    }
  } catch (e) {
    console.warn("[SpacePatch] Non-fatal patch warning:", e.message);
  }

  persistence.restore();
  const app = spawn(process.execPath, ["custom-server.js"], {
    cwd: "/app",
    env: { ...process.env, PORT: String(appPort), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });
  backupTimer = setInterval(() => {
    persistence.backupNow().catch((error) => console.error("[Persistence] Backup failed:", error));
  }, 60000);
  app.on("exit", async (code, signal) => {
    console.error(`9router exited: ${signal || code}`);
    clearInterval(backupTimer);
    clearTimeout(backupDelay);
    server.close();
    try { await persistence.backupNow(); }
    catch (error) { console.error("[Persistence] Final backup failed:", error); }
    process.exit(code || 1);
  });
  process.on("SIGTERM", () => app.kill("SIGTERM"));
  process.on("SIGINT", () => app.kill("SIGINT"));
  server.listen(publicPort, "0.0.0.0", () => {
    console.log(`9router Space proxy listening on ${publicPort}`);
  });
} catch (error) {
  console.error("[Persistence] Startup failed:", error);
  process.exit(1);
}
