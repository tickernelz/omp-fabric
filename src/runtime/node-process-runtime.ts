import { spawn, type ChildProcess } from "node:child_process";
import { runAbortable, settleWithin } from "../async-settlement.js";
import { ompBashExitMetadata } from "../core/omp-bash-error.js";
import { isOmpShellRef } from "../core/omp-tools.js";
import {
  GUEST_SETUP,
  type FabricHostCall,
  type FabricSandboxOptions,
  type FabricSandboxResult,
} from "./quickjs-runtime.js";
import { NODE_PROCESS_CHILD_SOURCE } from "./node-process-child-source.js";
import { createGuestStackMap, remapGuestErrorText } from "./guest-stack-map.js";
import { transpileFabricCodeWithSourceMap } from "./type-checker.js";
import {
  resolveScriptRuntime,
  resolveScriptRuntimeSync,
} from "../agents/transports/process-utils.js";

interface ChildCallMessage {
  type: "call";
  id: number;
  ref: string;
  args: Record<string, unknown>;
}

interface ChildResultMessage {
  type: "result";
  result: FabricSandboxResult;
}

type ChildMessage = ChildCallMessage | ChildResultMessage;

const HOST_TASK_SETTLE_GRACE_MS = 250;

const STDERR_TAIL_CHARS = 4_000;

const OUT_OF_MEMORY_PATTERNS = [
  /heap out of memory/i,
  /out of memory/i,
  /allocation failed/i,
  /memory limit exceeded/i,
  /Cannot allocate memory/i,
];

const createStderrTail = (
  stream: NodeJS.ReadableStream | null,
  limit: number,
): (() => string) => {
  let tail = "";
  stream?.setEncoding?.("utf8");
  stream?.on?.("data", (chunk: string) => {
    tail = (tail + chunk).slice(-limit);
  });
  stream?.on?.("error", () => undefined);
  return () => tail.trim();
};

const diagnoseChildExit = (detail: string, stderrTail: string): string => {
  const base = `Process executor exited before returning a result (${detail})`;
  if (!stderrTail) {
    return `${base}. The child wrote nothing to stderr; rerun with a narrower program to isolate the crash.`;
  }
  const outOfMemory = OUT_OF_MEMORY_PATTERNS.some((pattern) => pattern.test(stderrTail));
  const verdict = outOfMemory
    ? "The child ran out of memory. Narrow the program or raise executor.memoryLimitBytes."
    : "The child crashed. The stderr tail below carries the real cause.";
  return `${base}. ${verdict}\n--- child stderr (tail) ---\n${stderrTail}`;
};


const send = (child: ChildProcess, message: any): void => {
  if (!child.connected) return;
  child.send(message, () => undefined);
};

export class NodeProcessRuntime {
  readonly #interpreter: "node" | "bun";

  constructor(interpreter: "node" | "bun" = "node") {
    this.#interpreter = interpreter;
  }

  async execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult> {
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    if (!Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 1) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "Process memory limit must be a positive safe integer",
      };
    }

    // Bun evaluates --eval input as ESM and ignores V8 heap flags, so the
    // Bun child gets the guest source bare; Node needs the module + heap flags.
    // Bun resolution stays async: OMP may legitimately run under Node while bun
    // is only available on PATH, and the sync variant does no PATH lookup.
    const runtimeOptions = this.#interpreter === "bun" ? { requireBun: true } : { requireNode: true };
    const interpreterPath = this.#interpreter === "bun"
      ? await resolveScriptRuntime(runtimeOptions)
      : resolveScriptRuntimeSync(runtimeOptions);
    const child = spawn(
      interpreterPath,
      this.#interpreter === "bun"
        ? ["--eval", NODE_PROCESS_CHILD_SOURCE]
        : [
            `--max-old-space-size=${Math.max(16, Math.floor(options.memoryLimitBytes / (1024 * 1024)))}`,
            "--input-type=module",
            "--eval",
            NODE_PROCESS_CHILD_SOURCE,
          ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const childStderr = createStderrTail(child.stderr, STDERR_TAIL_CHARS);
    // Bun resolution is async, so the signal may have aborted while resolving.
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    const hostAbortController = new AbortController();
    const startedAt = Date.now();
    let effectiveTimeoutMs = options.timeoutMs;
    let deadlineAt = startedAt + effectiveTimeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let settled = false;
    let finishing = false;
    const hostTasks = new Set<Promise<void>>();

    const guestBundle = options.transpiledCode === undefined
      ? transpileFabricCodeWithSourceMap(code)
      : { code: options.transpiledCode, sourceMap: options.transpiledSourceMap };
    const guestStackMap = createGuestStackMap(guestBundle.sourceMap);
    const guestLineCount = guestBundle.code.split("\n").length;

    return new Promise<FabricSandboxResult>((resolve) => {
      const finish = (result: FabricSandboxResult): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
        if (!hostAbortController.signal.aborted && hostTasks.size > 0) {
          hostAbortController.abort(new Error(result.error ?? "Process execution stopped"));
        }
        child.removeAllListeners();
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(result);
      };
      const scheduleDeadline = (): void => {
        if (deadline) clearTimeout(deadline);
        deadline = setTimeout(() => {
          const error = `Execution timed out after ${effectiveTimeoutMs}ms`;
          finish({ value: undefined, logs: [], terminationReason: "timed_out", error });
        }, Math.max(0, deadlineAt - Date.now()));
        deadline.unref?.();
      };
      const extendDeadline = (ref: string, args: Record<string, unknown>): void => {
        const requested = options.minimumTimeoutMsForHostCall?.(ref, args);
        if (typeof requested !== "number" || !Number.isFinite(requested)) return;
        const nextDeadlineAt = Date.now() + Math.max(1, Math.floor(requested));
        if (nextDeadlineAt <= deadlineAt) return;
        deadlineAt = nextDeadlineAt;
        effectiveTimeoutMs = deadlineAt - startedAt;
        scheduleDeadline();
      };

      abortHandler = () => {
        finish({
          value: undefined,
          logs: [],
          terminationReason: "aborted",
          error: "Execution cancelled",
        });
      };
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      child.on("message", (raw: unknown) => {
        if (settled || finishing || typeof raw !== "object" || raw === null) return;
        const message = raw as ChildMessage;
        if (message.type === "result") {
          finishing = true;
          if (deadline) clearTimeout(deadline);
          if (message.result.terminationReason !== "completed" && !hostAbortController.signal.aborted) {
            hostAbortController.abort(new Error(message.result.error ?? "Process execution stopped"));
          }
          void (async () => {
            const completed = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
            if (!completed && !hostAbortController.signal.aborted) {
              hostAbortController.abort(
                new Error("Fabric guest execution ended before its host calls settled"),
              );
              await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
            }
            finish(
              message.result.error === undefined
                ? message.result
                : {
                    ...message.result,
                    error: remapGuestErrorText(message.result.error, guestStackMap, guestLineCount),
                  },
            );
          })();
          return;
        }
        if (message.type !== "call") return;
        extendDeadline(message.ref, message.args);
        const task = runAbortable(hostAbortController.signal, () =>
          hostCall(message.ref, message.args, hostAbortController.signal),
        ).then(
          (value) => send(child, { type: "response", id: message.id, ok: true, value }),
          (error) =>
            send(child, {
              type: "response",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              bashExit: isOmpShellRef(message.ref) ? ompBashExitMetadata(error) : undefined,
            }),
        );
        hostTasks.add(task);
        void task.finally(() => hostTasks.delete(task));
      });
      child.once("error", (error) => {
        finish({
          value: undefined,
          logs: [],
          terminationReason: "runtime_error",
          error: `Process executor failed: ${error.message}`,
        });
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        const detail = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`;
        const tail = childStderr();
        const diagnosis = diagnoseChildExit(detail, tail);
        finish({
          value: undefined,
          logs: [],
          terminationReason: "runtime_error",
          error: diagnosis,
        });
      });

      scheduleDeadline();
      send(child, {
        type: "execute",
        setup: GUEST_SETUP,
        code: guestBundle.code,
        payloads: options.payloads ?? {},
        proxyNames: options.proxyNames ?? {},
        tokenBudget: options.tokenBudget,
        maxLogChars: options.maxLogChars ?? 100_000,
      });
    });
  }
}

export class BunProcessRuntime extends NodeProcessRuntime {
  constructor() {
    super("bun");
  }
}
