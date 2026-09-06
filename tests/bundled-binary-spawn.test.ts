import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/agents/types.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const workerPath = path.resolve("dist/worker.js");
const ompBinary = path.resolve("tests/fixtures/fake-omp.mjs");
const hasWorker = fs.existsSync(workerPath);
const fakeBundledExecPath = "/usr/local/bin/omp";

describe.skipIf(!hasWorker)("agent worker launch under a bundled OMP binary", () => {
  const roots: string[] = [];
  const managers: AgentManager[] = [];
  const originalExecPath = process.execPath;
  const originalOverride = process.env.OMP_FABRIC_NODE_BINARY;
  const originalBehavior = process.env.FAKE_OMP_BEHAVIOR;

  afterEach(async () => {
    process.execPath = originalExecPath;
    if (originalOverride === undefined) delete process.env.OMP_FABRIC_NODE_BINARY;
    else process.env.OMP_FABRIC_NODE_BINARY = originalOverride;
    if (originalBehavior === undefined) delete process.env.FAKE_OMP_BEHAVIOR;
    else process.env.FAKE_OMP_BEHAVIOR = originalBehavior;
    await Promise.all(managers.splice(0).map((m) => m.close()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves a JS runtime and completes a subagent when process.execPath is the OMP binary", async () => {
    const realNode = originalExecPath;
    process.execPath = fakeBundledExecPath;
    process.env.OMP_FABRIC_NODE_BINARY = realNode;
    process.env.FAKE_OMP_BEHAVIOR = "success";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-bundled-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 20_000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, { workerPath, ompBinary, runRoot: root });
    managers.push(manager);
    const result: AgentRunResult = await manager.run({ task: "ok", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.text).toContain("hi");
  });
});
