import { spawn, type StdioOptions } from "child_process";
import { readConfigFile } from ".";
import { closeService } from "./close";
import {
  decrementReferenceCount,
  incrementReferenceCount,
} from "./processCheck";
import { quote } from 'shell-quote';
import minimist from "minimist";
import { createEnvVariables } from "./createEnvVariables";


export async function executeCodeCommand(args: string[] = []) {
  // Set environment variables using shared function
  const config = await readConfigFile();
  const env = await createEnvVariables();
  const settingsFlag = {
    env
  };
  if (config?.StatusLine?.enabled) {
    settingsFlag.statusLine = {
      type: "command",
      command: "ccr statusline",
      padding: 0,
    }
  }
  args.push('--settings', `${JSON.stringify(settingsFlag)}`);

  // Non-interactive mode for automation environments
  if (config.NON_INTERACTIVE_MODE) {
    env.CI = "true";
    env.FORCE_COLOR = "0";
    env.NODE_NO_READLINE = "1";
    env.TERM = "dumb";
  }

  // Set ANTHROPIC_SMALL_FAST_MODEL if it exists in config
  if (config?.ANTHROPIC_SMALL_FAST_MODEL) {
    env.ANTHROPIC_SMALL_FAST_MODEL = config.ANTHROPIC_SMALL_FAST_MODEL;
  }

  // Increment reference count when command starts
  incrementReferenceCount();

  // Determine tracing
  const traceEnabled = process.env.CCR_TRACE_ENABLED === "true";
  const traceLog = process.env.CCR_TRACE_LOG_NAME;
  const traceBin = process.env.CCR_TRACE_BIN || "claude-trace";
  const traceLogDir =
    process.env.CCR_TRACE_LOG_DIR ||
    (process.env.HOME ? `${process.env.HOME}/.claude-trace` : undefined);

  // Execute claude command (or claude-trace wrapper)
  const claudePath = traceEnabled
    ? traceBin
    : config?.CLAUDE_PATH || process.env.CLAUDE_PATH || "claude";

  const joinedArgs = args.length > 0 ? quote(args) : "";

  const stdioConfig: StdioOptions = config.NON_INTERACTIVE_MODE
    ? ["pipe", "inherit", "inherit"] // Pipe stdin for non-interactive
    : "inherit"; // Default inherited behavior

  const argsObj = minimist(args)
  const argsArr = []
  // Strip tracing flags from argsObj so they are not forwarded to claude
  delete argsObj.trace;
  delete (argsObj as any)["trace-log"];
  delete (argsObj as any).traceLog;
  delete (argsObj as any).tracelog;
  delete (argsObj as any)["trace-bin"];
  delete (argsObj as any).traceBin;
  delete (argsObj as any).tl;
  // Strip thinking flag; the Claude CLI doesn't understand it
  delete (argsObj as any).thinking;
  // Strip allow-web-tools flag; handled by CCR only
  delete (argsObj as any)["allow-web-tools"];
  delete (argsObj as any).allowWebTools;

  for (const [argsObjKey, argsObjValue] of Object.entries(argsObj)) {
    if (argsObjKey !== '_' && argsObj[argsObjKey]) {
      const prefix = argsObjKey.length === 1 ? '-' : '--';
      // For boolean flags, don't append the value
      if (argsObjValue === true) {
        argsArr.push(`${prefix}${argsObjKey}`);
      } else {
        argsArr.push(`${prefix}${argsObjKey} ${JSON.stringify(argsObjValue)}`);
      }
    }
  }

  // Remove tracing flags from the raw args for claude-trace pass-through
  const sanitizedArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const isTraceFlag =
      flag === "--trace" ||
      flag === "--trace-log" ||
      flag === "--traceLog" ||
      flag === "--trace-bin" ||
      flag === "--traceBin" ||
      flag === "--tracelog" ||
      flag === "--tl" ||
      flag.startsWith("--trace-log=") ||
      flag.startsWith("--traceLog=") ||
      flag.startsWith("--trace-bin=") ||
      flag.startsWith("--traceBin=") ||
      flag.startsWith("--tracelog=") ||
      flag.startsWith("--tl=");
    const isThinkingFlag = flag === "--thinking" || flag === "--thinking=true" || flag === "--thinking=false";
    const isAllowWebToolsFlag =
      flag === "--allow-web-tools" ||
      flag === "--allowWebTools" ||
      flag === "--allow-web-tools=true" ||
      flag === "--allow-web-tools=false";
    if (isTraceFlag) {
      // Skip this flag and its value if provided as next arg
      if (
        flag === "--trace-log" ||
        flag === "--traceLog" ||
        flag === "--trace-bin" ||
        flag === "--traceBin" ||
        flag === "--tracelog" ||
        flag === "--tl"
      ) {
        i += 1;
      }
      continue;
    }
    if (isThinkingFlag) {
      continue;
    }
    if (isAllowWebToolsFlag) {
      continue;
    }
    sanitizedArgs.push(flag);
  }

  const finalArgs = traceEnabled
    ? [
        ...(traceLog ? ["--log", traceLog] : []),
        "--run-with",
        ...sanitizedArgs,
      ]
    : argsArr;

  const envForSpawn = {
    ...process.env,
    ...(traceEnabled && traceLogDir
      ? { CLAUDE_TRACE_LOG_DIR: traceLogDir }
      : {}),
  };

  const claudeProcess = spawn(
    claudePath,
    finalArgs,
    {
      env: envForSpawn,
      stdio: stdioConfig,
      shell: traceEnabled ? false : true,
      cwd: traceEnabled ? process.cwd() : undefined,
    }
  );

  // Close stdin for non-interactive mode
  if (config.NON_INTERACTIVE_MODE) {
    claudeProcess.stdin?.end();
  }

  claudeProcess.on("error", (error) => {
    console.error("Failed to start claude command:", error.message);
    console.log(
      "Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code"
    );
    decrementReferenceCount();
    process.exit(1);
  });

  claudeProcess.on("close", (code) => {
    decrementReferenceCount();
    closeService();
    process.exit(code || 0);
  });
}
