import os from "node:os";
import path from "node:path";
import { buildSessionContext, type SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { estimateTokens as hostEstimateTokens } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { calculateContextTokens as hostCalculateContextTokens, DEFAULT_COMPACTION_SETTINGS as hostCompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentDir } from "../src/core/agent-dir.js";
import { calculateContextTokens as localCalculateContextTokens, DEFAULT_COMPACTION_SETTINGS as localCompactionSettings, estimateTokens as localEstimateTokens } from "../src/core/token-math.js";
import { buildSessionContext as localBuildSessionContext, sessionEntryToContextMessages as localSessionEntry } from "../src/core/session-context.js";

const envBackup = process.env.OMP_FABRIC_AGENT_DIR;
const dirAtLoad = getAgentDir();
afterEach(() => {
  setAgentDir(dirAtLoad);
  const path = envBackup;
  if (path === undefined) delete process.env.OMP_FABRIC_AGENT_DIR;
  else process.env.OMP_FABRIC_AGENT_DIR = path;
});

describe("host parity", () => {
  it("estimates tokens identically to the host", () => {
    const messages = [
      { role: "user", content: "hello world" },
      { role: "user", content: [{ type: "text", text: "abc" }, { type: "image" }] },
      { role: "user", content: [{ type: "image" }] },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "abcde" }, { type: "text", text: "fghij" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "abcde" }, { type: "thinking", thinking: "hmm" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(2001) }, { type: "text", text: "y".repeat(1001) }] },
      { role: "assistant", content: [{ type: "text", text: "abcd" }, { type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "bash", arguments: { cmd: "ls" } }] },
      { role: "assistant", content: [{ type: "toolCall", name: "abc", arguments: { a: "q".repeat(101) } }] },
      { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
      { role: "toolResult", content: "output" },
      { role: "toolResult", content: [{ type: "image" }] },
      { role: "toolResult", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(400) }, { type: "image" }] },
      { role: "custom", customType: "x", content: "custom text" },
      { role: "bashExecution", command: "a", output: "b" },
      { role: "bashExecution", command: "echo hi", output: "hi" },
      { role: "branchSummary", summary: "branch" },
      { role: "compactionSummary", summary: "compaction" },
    ];
    for (const message of messages) {
      expect(localEstimateTokens(message as never)).toBe(hostEstimateTokens(message as never));
    }
  });

  it("counts context tokens identically to the host", () => {
    const usages = [
      { totalTokens: 1000 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 0 },
    ];
    for (const usage of usages) {
      expect(localCalculateContextTokens(usage)).toBe(hostCalculateContextTokens(usage as never));
    }
    expect(localCalculateContextTokens(undefined)).toBe(0);
  });

  it("mirrors the host defaults for every compaction setting it reuses", () => {
    expect(localCompactionSettings.enabled).toBe(hostCompactionSettings.enabled);
    expect(localCompactionSettings.keepRecentTokens).toBe(hostCompactionSettings.keepRecentTokens);
    expect(hostCompactionSettings).not.toHaveProperty("reserveTokens");
    expect(localCompactionSettings.reserveTokens).toBeGreaterThan(0);
  });

  it("projects each session entry the way the host projects it", () => {
    const entries: SessionEntry[] = ([
      { id: "u1", type: "message", timestamp: 10, message: { role: "user", content: null } },
      {
        id: "m1", type: "message", timestamp: 11, parentId: "u1",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "openai", model: "gpt-4" },
      },
      {
        id: "c1", type: "custom_message", timestamp: 12, parentId: "m1", customType: "wave",
        content: [{ type: "text", text: "yo" }], display: true, details: { a: 1 },
      },
      { id: "b1", type: "branch_summary", timestamp: 13, parentId: "c1", summary: "sum", fromId: "u1" },
      { id: "p1", type: "compaction", timestamp: 14, parentId: "b1", summary: "compacted", tokensBefore: 500, firstKeptEntryId: "m1" },
      { id: "v1", type: "var", timestamp: 15, parentId: "p1", key: "k", value: "v" },
    ] as unknown as SessionEntry[]);
    expect(localBuildSessionContext(entries)).toEqual(buildSessionContext(entries));
    for (const entry of entries) {
      expect(Array.isArray(localSessionEntry(entry))).toBe(true);
    }
  });

  it("builds session context identically", () => {
    const entries = ([
      { id: "root", type: "message", timestamp: 1, message: { role: "user", content: "start" } },
      {
        id: "t", type: "thinking_level_change", timestamp: 2, thinkingLevel: "high",
        parentId: "root",
      },
      {
        id: "mc", type: "model_change", timestamp: 3, provider: "anthropic", modelId: "sonnet",
        parentId: "t",
      },
      {
        id: "p1", type: "compaction", timestamp: 4, summary: "sum", tokensBefore: 10,
        firstKeptEntryId: "t", parentId: "mc",
      },
      {
        id: "tail", type: "message", timestamp: 5,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "anthropic", model: "sonnet" },
        parentId: "p1",
      },
      { id: "tk", type: "toolResult", timestamp: 6, message: { role: "toolResult", content: "out" }, parentId: "tail" },
    ] as unknown as SessionEntry[]);
    expect(localBuildSessionContext(entries)).toEqual(buildSessionContext(entries));
    expect(localBuildSessionContext(entries, "tail")).toEqual(buildSessionContext(entries, "tail"));
  });

  it("resolves the agent directory identically", () => {
    delete process.env.OMP_FABRIC_AGENT_DIR;
    expect(resolveAgentDir()).toBe(getAgentDir());

    setAgentDir(path.resolve(os.tmpdir(), "omp-agent-parity"));
    expect(resolveAgentDir()).toBe(getAgentDir());
    expect(resolveAgentDir()).toBe(path.resolve(os.tmpdir(), "omp-agent-parity"));
  });

  it("expands a leading tilde in the Fabric agent-dir override", () => {
    process.env.OMP_FABRIC_AGENT_DIR = "~/omp-agent-parity";
    expect(resolveAgentDir()).toBe(path.join(os.homedir(), "omp-agent-parity"));
  });
});
