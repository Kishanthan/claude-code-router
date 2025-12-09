// ~/.claude-code-router/custom-router.js
const { appendFile, mkdir } = require("fs/promises");
const path = require("path");
const HOME = require("os").homedir();
const DIR = path.join(HOME, ".claude-code-router", "logs", "trajectories");

// pick one mode: "session", "timestamp", or leave undefined for single file
const MODE = "session"; // or "timestamp"

const safe = (s) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
const targetFile = (req) => {
  if (MODE === "session" && req.body?.metadata?.user_id) {
    return path.join(DIR, `session-${safe(req.body.metadata.user_id)}.jsonl`);
  }
  if (MODE === "timestamp") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(DIR, `request-${ts}.jsonl`);
  }
  return path.join(DIR, "requests.jsonl");
};

async function log(req) {
  await mkdir(DIR, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    url: req.url,
    model: req.body?.model,
    system: req.body?.system,
    messages: req.body?.messages,
    tools: req.body?.tools,
    metadata: req.body?.metadata,
  };
  await appendFile(targetFile(req), JSON.stringify(record) + "\n", "utf8");
}

module.exports = async function router(req, _config) {
  await log(req);
  return null; // fall back to default routing
};