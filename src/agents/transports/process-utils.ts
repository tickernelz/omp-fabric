import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export const executeFile = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecFileResult> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

// Resolve against the caller's own PATH. A shell probe cannot: `sh -lc` rebuilds
// PATH from the login profile, which drops per-session managers (fnm, nvm, the
// CI tool cache) and reports an installed runtime as missing.
export const commandAvailable = async (command: string): Promise<boolean> =>
  resolveCommandPath(command) !== undefined;

const resolveCommandPath = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command) ? command : undefined;
  }
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
};

const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // On Windows, EPERM means the process exists but cannot be opened for
    // signaling; only ESRCH (or other errors) mean it is gone.
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const GENERIC_RUNTIME = /^(node|bun)(\.exe)?$/;

type RuntimeFlavor = "node" | "bun";

const SCRIPT_RUNTIME_ORDER: readonly RuntimeFlavor[] = ["bun", "node"];

export interface ScriptRuntimeOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Require Node.js specifically; used by the Node-process executor whose
   *  `--eval`/`--input-type=module` flags are Node-only. */
  requireNode?: boolean;
  /** Require Bun specifically; used by the Bun-process executor. */
  requireBun?: boolean;
}

const runtimeOverride = (env: NodeJS.ProcessEnv): string | undefined => {
  const value = env.OMP_FABRIC_NODE_BINARY;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const isRuntimeFlavor = (execPath: string, flavor: RuntimeFlavor): boolean => {
  const name = path.basename(execPath).toLowerCase();
  return GENERIC_RUNTIME.test(name) && name.startsWith(flavor);
};

const isGenericRuntime = (execPath: string, requireNode: boolean, requireBun = false): boolean => {
  const name = path.basename(execPath).toLowerCase();
  return GENERIC_RUNTIME.test(name)
    && (!requireNode || name.startsWith("node"))
    && (!requireBun || name.startsWith("bun"));
};

const isWrongFlavorRuntime = (execPath: string, requireNode: boolean, requireBun: boolean): boolean => {
  const name = path.basename(execPath).toLowerCase();
  return GENERIC_RUNTIME.test(name)
    && ((requireNode && name.startsWith("bun")) || (requireBun && name.startsWith("node")));
};

const missingRuntimeError = (execPath: string, requireNode: boolean, requireBun = false): Error => {
  const required = requireNode
    ? "a Node.js runtime"
    : requireBun
      ? "a Bun runtime"
      : "a Bun or Node.js runtime";
  const shape = requireNode ? "(not node)" : requireBun ? "(not bun)" : "(not node/bun)";
  return new Error(
    `Fabric requires ${required} to launch a JavaScript worker, but ` +
      `process.execPath is ${execPath} ${shape} and OMP_FABRIC_NODE_BINARY is unset. ` +
      "Install Bun or Node.js, or set OMP_FABRIC_NODE_BINARY to the runtime binary.",
  );
};

const resolveScriptRuntimeCore = (
  options: ScriptRuntimeOptions,
  rejectWrongFlavorExecPath: boolean,
): string => {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const requireNode = options.requireNode === true;
  const requireBun = options.requireBun === true;
  if (requireNode || requireBun) {
    const flavor: RuntimeFlavor = requireNode ? "node" : "bun";
    if (isGenericRuntime(execPath, requireNode, requireBun)) return execPath;
    if (
      rejectWrongFlavorExecPath &&
      options.execPath !== undefined &&
      isWrongFlavorRuntime(execPath, requireNode, requireBun)
    ) {
      throw missingRuntimeError(execPath, requireNode, requireBun);
    }
    const override = runtimeOverride(env);
    if (override) return override;
    const resolved = resolveCommandPath(flavor, env);
    if (resolved) return resolved;
    throw missingRuntimeError(execPath, requireNode, requireBun);
  }
  const override = runtimeOverride(env);
  if (override) return override;
  for (const flavor of SCRIPT_RUNTIME_ORDER) {
    if (isRuntimeFlavor(execPath, flavor)) return execPath;
    const resolved = resolveCommandPath(flavor, env);
    if (resolved) return resolved;
  }
  throw missingRuntimeError(execPath, requireNode, requireBun);
};

const resolveScriptRuntimeUncached = async (options: ScriptRuntimeOptions = {}): Promise<string> =>
  resolveScriptRuntimeCore(options, false);

let cachedDefaultRuntime: string | undefined;
export const resolveScriptRuntime = async (options?: ScriptRuntimeOptions): Promise<string> => {
  if (
    options &&
    (options.execPath !== undefined ||
      options.env !== undefined ||
      options.requireNode !== undefined ||
      options.requireBun !== undefined)
  ) {
    return resolveScriptRuntimeUncached(options);
  }
  if (cachedDefaultRuntime) return cachedDefaultRuntime;
  cachedDefaultRuntime = await resolveScriptRuntimeUncached();
  return cachedDefaultRuntime;
};

export const resolveScriptRuntimeSync = (options: ScriptRuntimeOptions = {}): string =>
  resolveScriptRuntimeCore(options, true);

export const scriptSpawnArgs = async (
  workerPath: string,
  workerArguments: readonly string[],
  options?: ScriptRuntimeOptions,
): Promise<string[]> => {
  const runtime = await resolveScriptRuntime(options);
  return [runtime, workerPath, ...workerArguments];
};

export const workerCommand = async (
  workerPath: string,
  workerArguments: string[],
): Promise<string> =>
  (await scriptSpawnArgs(workerPath, workerArguments)).map(shellQuote).join(" ");

const TRANSPORT_STDERR_FILE = "transport-stderr.log";
const TRANSPORT_STDERR_TAIL_BYTES = 8 * 1024;
const TRANSPORT_STDERR_MAX_CHARS = 400;
const LAUNCH_MARKER = "[fabric] launching worker with ";

export const transportStderrPath = (runDirectory: string): string =>
  path.join(runDirectory, TRANSPORT_STDERR_FILE);

export const readTransportStderrSummary = (runDirectory: string): string | undefined => {
  try {
    const file = transportStderrPath(runDirectory);
    const { size } = statSync(file);
    if (size <= 0) return undefined;
    const start = Math.max(0, size - TRANSPORT_STDERR_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buffer
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);
    let runtime: string | undefined;
    const attempt: string[] = [];
    for (const line of lines) {
      if (line.startsWith(LAUNCH_MARKER)) {
        runtime = line.slice(LAUNCH_MARKER.length);
        attempt.length = 0;
        continue;
      }
      attempt.push(line);
    }
    const cause =
      attempt.find((line) => /^[\w$.]*Error\b/.test(line))
      ?? attempt.find((line) => /error|cannot|unsupported|not found|permission denied/i.test(line))
      ?? attempt.at(-1);
    if (!cause) return undefined;
    const detail = cause.slice(0, TRANSPORT_STDERR_MAX_CHARS);
    return runtime ? `${runtime}: ${detail}` : detail;
  } catch {
    return undefined;
  }
};

export const clearTransportStderr = (runDirectory: string): void => {
  try {
    rmSync(transportStderrPath(runDirectory), { force: true });
  } catch { /* ignored */ }
};

const openStderrSink = (file: string, runtime: string): number | undefined => {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const fd = openSync(file, "a");
    try {
      writeSync(fd, `${LAUNCH_MARKER}${runtime}\n`);
    } catch { /* ignored */ }
    return fd;
  } catch {
    return undefined;
  }
};

export const spawnDetached = async (
  workerPath: string,
  workerArguments: string[],
  cwd: string,
  options: { stderrFile?: string } = {},
): Promise<{ pid: number; stop(): Promise<void>; isAlive(): Promise<boolean> }> => {
  const runtime = await resolveScriptRuntime();
  const stderrFd = options.stderrFile ? openStderrSink(options.stderrFile, runtime) : undefined;
  try {
    const child = spawn(runtime, [workerPath, ...workerArguments], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
    });
    if (!child.pid) throw new Error(`Failed to launch Fabric worker process with ${runtime}`);
    const pid = child.pid;
    child.unref();
    return {
      pid,
      async stop() {
        try {
          process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
        } catch { /* process group already exited */ }
      },
      async isAlive() {
        return processIsAlive(pid);
      },
    };
  } finally {
    if (stderrFd !== undefined) {
      try {
        closeSync(stderrFd);
      } catch { /* ignored */ }
    }
  }
};
