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
  const customName =
    config.LOG_TRAJECTORY_NAME || process.env.LOG_TRAJECTORY_NAME;
  const safeName = customName
    ? customName.toString().replace(/[^a-zA-Z0-9_.-]/g, "_")
    : "";
  const safeSession = getSafeSessionId(req.sessionId);

  const base = safeName ? `${safeName}-` : "";

  if (mode === "session" && safeSession) {
    return path.join(TRAJECTORY_DIR, `${base}session-${safeSession}.jsonl`);
  }

  if (mode === "timestamp") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(TRAJECTORY_DIR, `${base}request-${ts}.jsonl`);
  }

  return safeName
    ? path.join(TRAJECTORY_DIR, `${base}requests.jsonl`)
    : DEFAULT_FILE;
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

const collectIndexedObjectText = (value: any) => {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const keys = Object.keys(value);
  if (!keys.length) return null;
  if (!keys.every((k) => /^\d+$/.test(k))) return null;
  return keys
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => {
      const v = (value as any)[k];
      return typeof v === "string" ? v : "";
    })
    .join("");
};

const dropIndexedKeys = (obj: any) => {
  if (!obj || typeof obj !== "object") return;
  Object.keys(obj)
    .filter((k) => /^\d+$/.test(k))
    .forEach((k) => delete obj[k]);
};

const normalizeResponse = (response: any) => {
  if (!response) return undefined;
  const rawCopy = (() => {
    try {
      return JSON.parse(JSON.stringify(response));
    } catch {
      return response;
    }
  })();
  const normalized: Record<string, any> = { ...response };

  // If events were captured from streaming, rebuild combined text/reasoning and summarize.
  if (Array.isArray(response.events)) {
    const parts: string[] = [];
    const reasoningParts: string[] = [];
    const tools: any[] = [];
    let currentTool: {
      id?: string;
      name?: string;
      partial: string;
      index?: number;
    } | null = null;

    response.events.forEach((evt: any) => {
      const data = evt?.data ?? evt;
      collectText(data?.delta?.text, parts);
      collectText(data?.delta?.content, parts);
      collectText(data?.delta?.content_block?.text, parts);
      collectText(data?.delta?.reasoning_content, reasoningParts);
      collectText(data?.message?.content, parts);
      collectText(data?.message?.reasoning_content, reasoningParts);

      // Rebuild tool_use inputs
      if (data?.type === "content_block_start" && data?.content_block?.type === "tool_use") {
        currentTool = {
          id: data.content_block.id,
          name: data.content_block.name,
          partial: "",
          index: data.index,
        };
      } else if (
        currentTool &&
        data?.type === "content_block_delta" &&
        data?.delta?.type === "input_json_delta" &&
        data.index === currentTool.index
      ) {
        currentTool.partial += data.delta.partial_json ?? "";
      } else if (
        currentTool &&
        data?.type === "content_block_stop" &&
        data.index === currentTool.index
      ) {
        const rawInput = currentTool.partial || "";
        let parsedInput: any = rawInput;
        try {
          parsedInput = JSON.parse(rawInput);
        } catch {
          // keep raw string if parse fails
        }
        tools.push({
          id: currentTool.id,
          name: currentTool.name,
          input: parsedInput,
        });
        currentTool = null;
      }
    });
    if (parts.length) {
      normalized.text = parts.join("");
    }
    if (reasoningParts.length) {
      normalized.reasoning =
        typeof normalized.reasoning === "string"
          ? normalized.reasoning + reasoningParts.join("")
          : reasoningParts.join("");
    }
    if (tools.length) {
      normalized.tool_calls = tools;
    }
    // Summarize for readability; raw events are still available under `raw`.
    const summary: any[] = [];
    if (normalized.text) summary.push({ type: "text", content: normalized.text });
    if (normalized.reasoning) summary.push({ type: "reasoning", content: normalized.reasoning });
    tools.forEach((t) => summary.push({ type: "tool_use", ...t }));
    // Replace events with merged summary for readability.
    normalized.events = summary;
  }

  // Ensure text is a single string when provided as an array.
  if (Array.isArray(normalized.text)) {
    normalized.text = normalized.text.join("");
  }

  // Handle fragmented responses shaped like {"0":"{","1":"\"","2":"e",...}
  const indexedText = collectIndexedObjectText(normalized);
  if (!normalized.text && indexedText) {
    normalized.text = indexedText;
  }
  // Drop numeric keys after reconstruction to keep logs readable.
  dropIndexedKeys(normalized);

  // If tool calls are already present on the response, preserve them even without events.
  if (!normalized.tool_calls && response?.tool_calls) {
    normalized.tool_calls = response.tool_calls;
  }

  // Attach the full raw response snapshot for completeness.
  normalized.raw = rawCopy;

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
    const stage = extra.stage || "request";
    const normalizedResponse = extraResponse
      ? normalizeResponse(extraResponse)
      : undefined;
    const record: Record<string, any> = {
      timestamp: new Date().toISOString(),
      stage,
      sessionId: req.sessionId || null,
      url: req.url,
      method: req.method,
      model: req.body?.model,
      agents: req.agents,
      metadata: req.body?.metadata,
      ...restExtra,
    };
    // Only attach request payload details on request stage
    if (stage === "request") {
      record.system = req.body?.system;
      record.messages = req.body?.messages;
      record.tools = req.body?.tools;
    }
    if (normalizedResponse !== undefined) {
      (record as any).response = normalizedResponse;
    }
    const filePath = getTrajectoryFile(req, config);
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    req.log?.error?.("Failed to log trajectory", error);
  }
};
