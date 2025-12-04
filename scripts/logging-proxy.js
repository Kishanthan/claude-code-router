// Lightweight logging proxy for CCR: captures request/response in a single JSONL per session.
// Usage:
//   UPSTREAM="https://api.siliconflow.com/v1/chat/completions" PROXY_PORT=8899 node scripts/logging-proxy.js
// Then point your provider's api_base_url to http://127.0.0.1:8899/v1/chat/completions

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const UPSTREAM = process.env.UPSTREAM;
if (!UPSTREAM) {
  console.error("Missing UPSTREAM env var (e.g., https://api.siliconflow.com/v1/chat/completions)");
  process.exit(1);
}

const PORT = Number(process.env.PROXY_PORT || 8899);
const LOG_DIR =
  process.env.LOG_DIR ||
  path.join(os.homedir(), ".claude-code-router", "logs", "trajectories");

fs.mkdirSync(LOG_DIR, { recursive: true });

const upstreamUrl = new URL(UPSTREAM);
const useHttps = upstreamUrl.protocol === "https:";

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const safe = (s) => (s || "").toString().replace(/[^a-zA-Z0-9_-]/g, "_");
const sessionLogPath = (sessionId, ts) =>
  sessionId
    ? path.join(LOG_DIR, `session-${safe(sessionId)}.jsonl`)
    : path.join(LOG_DIR, `request-${ts}.jsonl`);

const proxyReq = (clientReq, clientRes, body, ts, sessionId) => {
  const requestOpts = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (useHttps ? 443 : 80),
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: upstreamUrl.host,
    },
  };

  const requester = useHttps ? https.request : http.request;
  const upstreamReq = requester(requestOpts, (upstreamRes) => {
    const resChunks = [];

    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.on("data", (chunk) => {
      resChunks.push(chunk);
      clientRes.write(chunk);
    });
    upstreamRes.on("end", () => {
      clientRes.end();
      const resBody = Buffer.concat(resChunks).toString();
      const logPath = sessionLogPath(sessionId, ts);
      fs.appendFileSync(
        logPath,
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            direction: "response",
            status: upstreamRes.statusCode,
            headers: upstreamRes.headers,
            body: resBody,
          }
        ) + "\n"
      );
    });
  });

  upstreamReq.on("error", (err) => {
    const logPath = sessionLogPath(sessionId, ts);
    fs.appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      direction: "error",
      error: err.stack || String(err),
    }) + "\n");
    clientRes.statusCode = 502;
    clientRes.end("proxy error");
  });

  upstreamReq.write(body);
  upstreamReq.end();
};

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on("data", (d) => chunks.push(d));
  clientReq.on("end", () => {
    const body = Buffer.concat(chunks);
    const ts = nowStamp();
    let sessionId = null;
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(body.toString() || "{}");
      if (parsedBody?.metadata?.user_id) {
        sessionId = parsedBody.metadata.user_id;
      }
    } catch {
      // leave sessionId null on parse errors
    }

    const reqLogPath = sessionLogPath(sessionId, ts);
    const reqLog = {
      ts: new Date().toISOString(),
      direction: "request",
      url: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers,
      body: parsedBody || body.toString(),
    };
    fs.appendFileSync(reqLogPath, JSON.stringify(reqLog) + "\n");

    proxyReq(clientReq, clientRes, body, ts, sessionId);
  });
});

server.listen(PORT, () => {
  console.log(
    `Logging proxy running on ${PORT}, forwarding to ${UPSTREAM}, logs in ${LOG_DIR}`
  );
});
