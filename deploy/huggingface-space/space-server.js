const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

const publicPort = Number(process.env.PORT || 20128);
const appPort = 20129;
const app = spawn(process.execPath, ["custom-server.js"], {
  cwd: "/app",
  env: { ...process.env, PORT: String(appPort), HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
});

function upstreamHeaders(request) {
  const headers = { ...request.headers };
  // Hugging Face uses Authorization to access a private Space. 9router must
  // receive its own API key instead, supplied separately as X-API-Key.
  delete headers.authorization;
  if (headers["x-api-key"]) {
    headers.authorization = `Bearer ${headers["x-api-key"]}`;
  }
  headers["x-forwarded-proto"] = "https";
  return headers;
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
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
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

app.on("exit", (code, signal) => {
  console.error(`9router exited: ${signal || code}`);
  server.close();
  process.exit(code || 1);
});
process.on("SIGTERM", () => app.kill("SIGTERM"));
process.on("SIGINT", () => app.kill("SIGINT"));
server.listen(publicPort, "0.0.0.0", () => {
  console.log(`9router Space proxy listening on ${publicPort}`);
});
