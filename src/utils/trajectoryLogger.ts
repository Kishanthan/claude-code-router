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
      ...extra,
    };
    const filePath = getTrajectoryFile(req, config);
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    req.log?.error?.("Failed to log trajectory", error);
  }
};
