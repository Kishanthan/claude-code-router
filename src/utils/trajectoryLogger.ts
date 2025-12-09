import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { HOME_DIR } from "../constants";

const TRAJECTORY_DIR = path.join(HOME_DIR, "logs", "trajectories");
const DEFAULT_FILE = path.join(TRAJECTORY_DIR, "requests.jsonl");

const ensureTrajectoryDir = async () => {
  await mkdir(TRAJECTORY_DIR, { recursive: true });
};

const getSafeSessionId = (sessionId?: string | null) => {
  if (!sessionId) return null;
  return sessionId.toString().replace(/[^a-zA-Z0-9_-]/g, "_");
};

const getTrajectoryFile = (req: any, config: any) => {
  const mode = config.LOG_TRAJECTORY_MODE;
  const safeSession = getSafeSessionId(req.sessionId);

  if (mode === "session" && safeSession) {
    return path.join(TRAJECTORY_DIR, `session-${safeSession}.jsonl`);
  }

  if (mode === "timestamp") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(TRAJECTORY_DIR, `request-${ts}.jsonl`);
  }

  return DEFAULT_FILE;
};

const collectText = (value: any, parts: string[]) => {
  if (!value) return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, parts));
    return;
  }
  if (typeof value === "object") {
    collectText(value.text, parts);
    collectText(value.content, parts);
  }
};

const normalizeResponse = (response: any) => {
  if (!response) return undefined;
  const normalized: Record<string, any> = { ...response };

  // If events were captured from streaming, rebuild a single text string.
  if (Array.isArray(response.events)) {
    const parts: string[] = [];
    response.events.forEach((evt: any) => {
      const data = evt?.data ?? evt;
      collectText(data?.delta?.text, parts);
      collectText(data?.delta?.content, parts);
      collectText(data?.delta?.content_block?.text, parts);
      collectText(data?.message?.content, parts);
    });
    if (parts.length) {
      normalized.text = parts.join("");
    }
    // Do not persist raw event stream in logs to keep files concise.
    delete normalized.events;
  }

  // Ensure text is a single string when provided as an array.
  if (Array.isArray(normalized.text)) {
    normalized.text = normalized.text.join("");
  }

  return normalized;
};

/**
 * Append a trajectory record under ~/.claude-code-router/logs/trajectories/
 * Controlled by config.LOG_TRAJECTORY (boolean). Default: disabled.
 * Optional config.LOG_TRAJECTORY_MODE: "session" | "timestamp" | undefined.
 */
export const logTrajectory = async (
  req: any,
  config: any,
  extra: Record<string, any> = {}
) => {
  if (config.LOG_TRAJECTORY !== true) return;
  try {
    await ensureTrajectoryDir();
    const { response: extraResponse, ...restExtra } = extra;
    const normalizedResponse = extraResponse
      ? normalizeResponse(extraResponse)
      : undefined;
    const record = {
      timestamp: new Date().toISOString(),
      stage: extra.stage || "request",
      sessionId: req.sessionId || null,
      url: req.url,
      method: req.method,
      model: req.body?.model,
      agents: req.agents,
      metadata: req.body?.metadata,
      system: req.body?.system,
      messages: req.body?.messages,
      tools: req.body?.tools,
      ...restExtra,
    };
    if (normalizedResponse !== undefined) {
      (record as any).response = normalizedResponse;
    }
    const filePath = getTrajectoryFile(req, config);
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    req.log?.error?.("Failed to log trajectory", error);
  }
};
