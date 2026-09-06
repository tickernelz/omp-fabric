#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { benchmarkGate, LfJsonlParser, pairedOrders, summarizeBenchmark } from "./certification/rpc-lib.mjs";
import { evaluateFixtureOracle, snapshotFiles } from "./certification/context-lib.mjs";

const RESUME_PROMPT = "Resume and complete the task.";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const fixture = {
  initialFiles: {
    "package.json": "{\"type\":\"module\"}\n",
    "verify.mjs": "import assert from 'node:assert/strict';\nimport { issueToken } from './src/token.js';\nassert.equal(issueToken('rare-user-43117'), 'token:rare-user-43117');\n",
    "forbidden.txt": "benchmark-control\n",
  },
  expectedFiles: {
    "package.json": "{\"type\":\"module\"}\n",
    "verify.mjs": "import assert from 'node:assert/strict';\nimport { issueToken } from './src/token.js';\nassert.equal(issueToken('rare-user-43117'), 'token:rare-user-43117');\n",
    "forbidden.txt": "benchmark-control\n",
    "src/token.js": "export const issueToken = (user) => `token:${user}`;\n",
  },
  forbiddenPaths: ["forbidden.txt", "verify.mjs"],
  test: { command: process.execPath, args: ["verify.mjs"] },
};

class RpcProcess {
  constructor(command, args, options) {
    this.events = [];
    this.pending = new Map();
    this.settledWaiters = [];
    this.stderr = "";
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parser = new LfJsonlParser((record) => this.#record(record));
    this.child.stdout.on("data", (chunk) => parser.push(chunk));
    this.child.stdout.on("end", () => parser.end());
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    this.exit = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));
    this.child.once("error", (error) => this.#rejectAll(error));
  }

  #record(record) {
    this.events.push(record);
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        record.success ? pending.resolve(record) : pending.reject(new Error(record.error ?? `RPC ${record.command} failed`));
      }
    }
    if (record.type === "agent_end") {
      for (const resolve of this.settledWaiters.splice(0)) resolve();
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  command(command, timeoutMs = 180_000) {
    const id = `request-${this.pending.size + this.events.length + 1}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${command.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  waitForSettled(timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RPC agent did not settle")), timeoutMs);
      timer.unref?.();
      this.settledWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  async close() {
    if (!this.child.killed) this.child.kill("SIGTERM");
    await Promise.race([this.exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (!this.child.killed) this.child.kill("SIGKILL");
  }
}

const writeInitialRepo = (root) => {
  for (const [relative, content] of Object.entries(fixture.initialFiles)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
};

const seedSession = (repo, sessionDir) => {
  const manager = SessionManager.create(repo, sessionDir);
  manager.appendMessage({
    role: "user",
    content: [
      "Create src/token.js exporting issueToken(user).",
      "It must return the exact string token:<user> and pass node verify.mjs.",
      "Do not change verify.mjs or forbidden.txt. Rare fixture value is rare-user-43117.",
    ].join("\n"),
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "I inspected the task; implementation is still pending." }],
    api: "anthropic-messages",
    provider: "benchmark-seed",
    model: "none",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  manager.appendMessage({ role: "user", content: "Pause now and hand this task off.", timestamp: Date.now() });
  const file = manager.getSessionFile();
  if (!file) throw new Error("Benchmark seed session was not persisted");
  return file;
};

const baseArgs = ({ config, sessionFile, fabricExtension }) => [
  "--mode", "rpc",
  "--session", sessionFile,
  "--provider", config.provider,
  "--model", config.model,
  "--thinking", "off",
  "--no-skills",
  "--no-extensions",
  "--extension", fabricExtension,
  "--auto-approve",
];

const prepareVariant = async ({ variant, config, repo, sessionFile, fabricExtension, env }) => {
  if (variant === "baseline") return { compactor: "none" };
  const rpc = new RpcProcess(config.ompCommand, baseArgs({ config, sessionFile, fabricExtension }), { cwd: repo, env });
  try {
    const response = await rpc.command({ type: "compact" });
    const details = response.data?.details;
    if (details?.compactor !== "fabric") throw new Error("Fabric arm was not compacted by Fabric");
    return { compactor: details.compactor, summaryBytes: Buffer.byteLength(response.data?.summary ?? "", "utf8") };
  } finally {
    await rpc.close();
  }
};

const runVariant = async ({ repeat, variant, config, root, fabricExtension, env }) => {
  const repo = path.join(root, `repeat-${repeat}`, variant, "repo");
  const sessionDir = path.join(root, `repeat-${repeat}`, variant, "sessions");
  fs.mkdirSync(repo, { recursive: true });
  writeInitialRepo(repo);
  const forbiddenBefore = snapshotFiles(repo, fixture.forbiddenPaths);
  const sessionFile = seedSession(repo, sessionDir);
  const preparation = await prepareVariant({ variant, config, repo, sessionFile, fabricExtension, env });
  const rpc = new RpcProcess(config.ompCommand, baseArgs({ config, sessionFile, fabricExtension }), { cwd: repo, env });
  const started = performance.now();
  try {
    const settled = rpc.waitForSettled();
    await rpc.command({ type: "prompt", message: RESUME_PROMPT });
    await settled;
    const stats = (await rpc.command({ type: "get_session_stats" })).data;
    const toolEvents = rpc.events.filter((event) => event.type === "tool_execution_start");
    const recallCalls = toolEvents.filter((event) => {
      if (event.toolName === "memory.recall") return true;
      return event.toolName === "fabric_exec"
        && typeof event.args?.code === "string"
        && event.args.code.includes("recall")
        && event.args.code.includes("memory");
    }).length;
    const oracle = evaluateFixtureOracle(repo, fixture, forbiddenBefore);
    return {
      repeat,
      variant,
      compactor: preparation.compactor,
      summaryBytes: preparation.summaryBytes ?? null,
      tokens: stats.tokens?.total ?? 0,
      costUsd: stats.cost ?? 0,
      toolCalls: toolEvents.length,
      recallCalls,
      wallMs: Math.round(performance.now() - started),
      diff: oracle.failures,
      oracle: { passed: oracle.passed, testStatus: oracle.test.status },
    };
  } finally {
    await rpc.close();
  }
};

const runBenchmark = async (gate) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-real-resume-"));
  const fabricExtension = path.resolve("dist/index.js");
  const env = { ...process.env };
  const orders = pairedOrders(gate.config.repeats, gate.config.seed);
  const runs = [];
  try {
    for (let repeat = 0; repeat < orders.length; repeat += 1) {
      for (const variant of orders[repeat]) {
        const observed = runs.reduce((sum, run) => sum + run.costUsd, 0);
        if (observed >= gate.config.maxUsd) throw new Error(`Benchmark stopped at configured budget ${gate.config.maxUsd} USD`);
        runs.push(await runVariant({ repeat: repeat + 1, variant, config: gate.config, root, fabricExtension, env }));
      }
    }
    return summarizeBenchmark(runs, orders, gate.config.maxUsd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const gate = benchmarkGate();
if (!gate.enabled) {
  process.stdout.write(`Real OMP resume benchmark: SKIP\n${gate.reasons.map((reason) => `  - ${reason}`).join("\n")}\n`);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, skipped: true, reasons: gate.reasons }, null, 2)}\n`);
} else {
  try {
    const report = await runBenchmark(gate);
    process.stdout.write(`Real OMP resume benchmark: COMPLETE (${report.runs.length} runs, $${report.budget.observedUsd.toFixed(4)})\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Real OMP resume benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
