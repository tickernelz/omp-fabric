#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { observeResidentOwner } from "./launcher-owner.js";

const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);
const spawnOmp = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof crossSpawn>[2],
): ReturnType<typeof crossSpawn> =>
  NODE_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase())
    ? crossSpawn(process.execPath, [command, ...args], options)
    : crossSpawn(command, [...args], options);

const parseConfigPath = (argv: readonly string[]): string => {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("Missing resident launcher argument: --config");
  return path.resolve(value);
};

const readConfig = (configPath: string): { cwd: string; ompBinary: string } => {
  const value: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Fabric resident host config");
  }
  const config = value as { cwd?: unknown; ompBinary?: unknown };
  if (typeof config.cwd !== "string" || typeof config.ompBinary !== "string") {
    throw new Error("Fabric resident host config is incomplete");
  }
  return { cwd: config.cwd, ompBinary: config.ompBinary };
};

const liveOwnerPid = (ownerPath: string): number | undefined => {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number") return undefined;
    process.kill(owner.pid, 0);
    return owner.pid;
  } catch {
    return undefined;
  }
};

const writeFailure = (configPath: string, error: unknown): void => {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "error.json"), JSON.stringify({
      error: message,
      occurredAt: Date.now(),
    }, null, 2));
    fs.appendFileSync(path.join(dir, "launcher.log"), `${JSON.stringify({ event: "launcher-failed", at: Date.now(), message })}\n`);
  } catch {
    // Startup diagnostics are best-effort.
  }
};

const configPath = parseConfigPath(process.argv);
try {
  const config = readConfig(configPath);
  // Lifecycle trace: the launcher can otherwise fail silently (broken args,
  // an unspawnable OMP binary), leaving the client to guess at the cause.
  const trace = (event: string, extra: Record<string, unknown> = {}): void => {
    try {
      const dir = path.dirname(configPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "launcher.log"), `${JSON.stringify({
        event, at: Date.now(), ...extra,
      })}\n`);
    } catch {
      // Diagnostics are best-effort.
    }
  };
  trace("launcher-started", { pid: process.pid, configPath, platform: process.platform });
  const entry = fileURLToPath(new URL("./omp-entry.js", import.meta.url));
  // OMP loads extension peers through its virtual module runtime; raw Node cannot.
  const child = spawnOmp(config.ompBinary, [
    "--mode", "rpc",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--extension", entry,
  ], {
    cwd: config.cwd,
    detached: false,
    // RPC ends on stdin EOF. Keep it open only while this child owns residency.
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OMP_FABRIC_RESIDENT_CONFIG: configPath },
  });
  let seenOwner = false;
  let claimedOwner = false;
  let closingInput = false;
  let stderr = "";
  const ownerPath = path.join(path.dirname(configPath), "owner.json");
  // The resident host may start slowly or fail silently; keep the child stderr
  // and the latest ownership observation on disk so a client-side startup
  // timeout can surface the real cause instead of a bare deadline error.
  const childLogPath = path.join(path.dirname(configPath), "child-stderr.log");
  try { fs.rmSync(childLogPath, { force: true }); } catch { /* best effort */ }
  // The extension loader may report load failures on stdout; capture both
  // streams so a silent child is diagnosable from the log alone.
  child.stdout?.on("data", (chunk: Buffer) => {
    try { fs.appendFileSync(childLogPath, chunk); } catch { /* best effort */ }
  });
  const ownerPoll = setInterval(() => {
    const observation = observeResidentOwner(liveOwnerPid(ownerPath), child.pid, claimedOwner);
    claimedOwner = observation.claimed;
    seenOwner ||= observation.observedOwner;
    if (observation.closeInput && !closingInput) {
      closingInput = true;
      child.stdin?.end();
    }
  }, 50);
  ownerPoll.unref();
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
    try { fs.appendFileSync(childLogPath, chunk); } catch { /* best effort */ }
  });
  trace("child-spawned", { pid: child.pid });
  child.on("error", (error) => {
    trace("child-error", { message: error instanceof Error ? error.message : String(error) });
    writeFailure(configPath, error);
  });
  child.on("exit", (code, signal) => {
    clearInterval(ownerPoll);
    trace("child-exit", { code, signal, seenOwner });
    if (!seenOwner) writeFailure(configPath, stderr.trim() || `OMP resident host exited (${signal ?? code ?? "unknown"})`);
    process.exitCode = code ?? 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }
} catch (error) {
  writeFailure(configPath, error);
  process.exitCode = 1;
}
