import { execFile, spawn } from "node:child_process";
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

export const commandAvailable = async (command: string): Promise<boolean> => {
  try {
    await executeFile("sh", ["-lc", `command -v ${shellQuote(command)}`], { timeoutMs: 2_000 });
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
      : "a Node.js or Bun runtime";
  const shape = requireNode ? "(not node)" : requireBun ? "(not bun)" : "(not node/bun)";
  return new Error(
    `Fabric requires ${required} to launch a JavaScript worker, but ` +
      `process.execPath is ${execPath} ${shape} and OMP_FABRIC_NODE_BINARY is unset. ` +
      "Install Node.js or Bun, or set OMP_FABRIC_NODE_BINARY to the runtime binary.",
  );
};

// Transports launch the worker (a .js module) as `<runtime> worker.js args`.
// Under the Bun-compiled OMP binary, process.execPath is the OMP executable,
// not node/bun, so it cannot run an arbitrary script. Resolve a real runtime
// before spawning: reuse process.execPath when it IS node/bun, else fall back
// to OMP_FABRIC_NODE_BINARY, then the first node/bun on PATH.
const resolveScriptRuntimeUncached = async (options: ScriptRuntimeOptions = {}): Promise<string> => {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const requireNode = options.requireNode === true;
  const requireBun = options.requireBun === true;
  if (isGenericRuntime(execPath, requireNode, requireBun)) return execPath;
  const override = runtimeOverride(env);
  if (override) return override;
  for (const candidate of requireNode ? ["node"] : requireBun ? ["bun"] : ["node", "bun"]) {
    if (await commandAvailable(candidate)) return candidate;
  }
  throw missingRuntimeError(execPath, requireNode, requireBun);
};

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

// Synchronous variant for callers that already run under a real runtime (e.g.
// the worker, which a transport always launches via the resolved runtime). No
// PATH lookup; throws if the current process is the bundled binary with no
// override set.
export const resolveScriptRuntimeSync = (options: ScriptRuntimeOptions = {}): string => {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const requireNode = options.requireNode === true;
  const requireBun = options.requireBun === true;
  if (isGenericRuntime(execPath, requireNode, requireBun)) return execPath;
  if (options.execPath !== undefined && isWrongFlavorRuntime(execPath, requireNode, requireBun)) {
    throw missingRuntimeError(execPath, requireNode, requireBun);
  }
  const override = runtimeOverride(env);
  if (override) return override;
  throw missingRuntimeError(execPath, requireNode, requireBun);
};

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

export const spawnDetached = async (
  workerPath: string,
  workerArguments: string[],
  cwd: string,
): Promise<{ pid: number; stop(): Promise<void>; isAlive(): Promise<boolean> }> => {
  const runtime = await resolveScriptRuntime();
  const child = spawn(runtime, [workerPath, ...workerArguments], {
    cwd,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("Failed to launch Fabric worker process");
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
};
