import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotHandoffSession, writeHandoffSession } from "../src/agents/handoff.js";
import { retireHandoffSeed } from "../src/prewalk/retirement.js";
import type { AgentSessionSeed, AgentToolResultMessage } from "../src/agents/types.js";
import type { ThinkingTransferInput } from "../src/agents/thinking-transfer.js";

const roots: string[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: Array<Record<string, unknown>>) => ({
  role: "assistant" as const,
  content,
  api: "anthropic",
  provider: "anthropic",
  model: "frontier",
  usage,
  stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" as const : "stop" as const,
  timestamp: Date.now(),
}) as unknown as Parameters<SessionManager["appendMessage"]>[0];

const PLANNER_BODY = `PLANNER_BODY_${"x".repeat(4000)}`;

const outerResult: AgentToolResultMessage = {
  role: "toolResult",
  toolCallId: "outer-1",
  toolName: "fabric_exec",
  content: [{ type: "text", text: "done" }],
  isError: false,
  timestamp: 3,
};

const handoffWith = async (transfer: ThinkingTransferInput) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-seam-"));
  roots.push(root);
  const source = SessionManager.create(root, path.join(root, "source"));
  source.appendMessage({ role: "user", content: "Plan the change", timestamp: 1 });
  source.appendMessage(assistant([
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/big.ts" } },
  ]));
  source.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: PLANNER_BODY }],
    isError: false,
    timestamp: 2,
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  source.appendMessage(assistant([
    { type: "toolCall", id: "outer-1", name: "fabric_exec", arguments: { code: "await omp.edit();" } },
  ]));

  const seed = snapshotHandoffSession(
    source,
    { provider: "anthropic", id: "frontier" },
    outerResult,
    "outer-1",
    true,
  );
  const retired = retireHandoffSeed(seed, { handoffRetirement: true, handoffRetirementKeep: 0 });
  const executorSeed: AgentSessionSeed = retired.plan.retired.length > 0
    ? { ...retired.seed, sourceBranchRetired: true }
    : retired.seed;
  const sessionFile = await writeHandoffSession(
    executorSeed,
    root,
    path.join(root, "child"),
    transfer,
  );
  return {
    seed,
    plan: retired.plan,
    raw: fs.readFileSync(sessionFile, "utf8"),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trajectory handoff retirement seam", () => {
  it.each([
    ["preserved", {
      source: { provider: "anthropic", modelId: "frontier", api: "anthropic-messages" },
      target: { provider: "anthropic", modelId: "executor", api: "anthropic-messages", reasoning: true },
    }],
    ["stripped", {
      source: { provider: "anthropic", modelId: "frontier", api: "anthropic-messages" },
      target: { provider: "openai", modelId: "executor", api: "openai-responses", reasoning: true },
    }],
    ["re-signed", {
      source: { provider: "anthropic", modelId: "frontier", api: "anthropic-messages" },
      target: { provider: "openai", modelId: "executor", api: "openai-completions", reasoning: true },
    }],
  ] as Array<[string, ThinkingTransferInput]>)(
    "hands the executor the pruned branch under a %s thinking transfer",
    async (_policy, transfer) => {
      const { seed, plan, raw } = await handoffWith(transfer);

      expect(seed.sourceSessionFile).toBeDefined();
      expect(plan.retired).toHaveLength(1);
      expect(plan.bytesRetired).toBeGreaterThan(512);
      expect(raw).not.toContain(PLANNER_BODY);
      expect(raw).toContain("[omp-fabric] retired read result");
    },
  );
});
