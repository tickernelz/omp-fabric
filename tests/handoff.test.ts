import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkedHandoffCompaction,
  snapshotHandoffSession,
  writeHandoffSession,
} from "../src/agents/handoff.js";
import type { AgentToolResultMessage } from "../src/agents/types.js";

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
  stopReason: content.some((part) => part.type === "toolCall")
    ? "toolUse" as const
    : "stop" as const,
  timestamp: Date.now(),
}) as unknown as Parameters<SessionManager["appendMessage"]>[0];

const outerResult = (toolCallId: string): AgentToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "fabric_exec",
  content: [{
    type: "text",
    text: "full Fabric program completed: read, edit one, edit two, tests passed",
  }],
  details: {
    success: true,
    trace: {
      kind: "omp-fabric.execution",
      version: 1,
      operations: ["omp.read", "omp.edit", "omp.edit", "omp.bash"],
    },
  },
  isError: false,
  timestamp: 20,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trajectory handoff sessions", async () => {
  it("forks through the outer fabric_exec call and appends its finalized native result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the token guard", timestamp: 1 });
    source.appendMessage(assistant([{ type: "text", text: "I found src/token.ts." }]));
    source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    const activeEntryId = source.appendMessage(
      assistant([
        { type: "thinking", thinking: "Run the complete implementation program." },
        { type: "text", text: "I will implement and verify the change." },
        {
          type: "toolCall",
          id: "outer-fabric-call",
          name: "fabric_exec",
          arguments: {
            code: "await omp.read(...); await omp.edit(...); await omp.edit(...); await omp.bash(...);",
          },
        },
      ]),
    );

    const result = outerResult("outer-fabric-call");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-fabric-call",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"));
    const child = await SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(seed.sourceBranchLeafId).toBe(activeEntryId);
    expect(child.getHeader()?.parentSession).toBe(source.getSessionFile());
    expect(child.getSessionId()).not.toBe(source.getSessionId());
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Run the complete implementation program." },
        { type: "text", text: "I will implement and verify the change." },
        {
          type: "toolCall",
          id: "outer-fabric-call",
          name: "fabric_exec",
          arguments: {
            code: "await omp.read(...); await omp.edit(...); await omp.edit(...); await omp.bash(...);",
          },
        },
      ],
    });
    expect(messages[4]).toEqual(result);
    expect(child.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("fabric_nested_");
    expect(source.getLeafId()).toBe(activeEntryId);
    expect(source.buildSessionContext().messages.at(-1)?.role).toBe("assistant");
    if (process.platform !== "win32") {
      expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it("materializes an in-memory source with the complete outer boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Preserve rare fact 43117", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "text", text: "Rare fact retained." },
        {
          type: "toolCall",
          id: "outer-in-memory",
          name: "fabric_exec",
          arguments: { code: "await omp.write(...); await omp.bash(...);" },
        },
      ]),
    );

    const result = outerResult("outer-in-memory");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-in-memory",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"));
    const child = await SessionManager.open(sessionFile);

    expect(child.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "Preserve rare fact 43117" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Rare fact retained." },
          { type: "toolCall", name: "fabric_exec" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "outer-in-memory",
        toolName: "fabric_exec",
        isError: false,
      },
    ]);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "omp-fabric-handoff",
      data: {
        sourceSessionId: source.getSessionId(),
        boundary: "fabric_exec_end",
      },
    });
  });

  it("fails rather than forking an incomplete parallel top-level tool batch", async () => {
    const source = SessionManager.inMemory();
    source.appendMessage({ role: "user", content: "Do both", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "toolCall", id: "outer", name: "fabric_exec", arguments: {} },
        { type: "toolCall", id: "sibling", name: "read", arguments: { path: "x" } },
      ]),
    );

    expect(() =>
      snapshotHandoffSession(
        source,
        { provider: "anthropic", id: "frontier" },
        outerResult("outer"),
        "outer",
      )
    ).toThrow(/only top-level tool call/);
  });

  it("re-signs foreign thinking for an openai-completions reasoning executor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Implement the guard", timestamp: 1 });
    const activeEntryId = source.appendMessage(
      assistant([
        {
          type: "thinking",
          thinking: "**Plan the token guard**\n\nsteps",
          thinkingSignature: '{"id":"rs_blob","type":"reasoning","encrypted_content":"gAAA"}',
        },
        { type: "text", text: "Implementing now." },
        {
          type: "toolCall",
          id: "outer-transfer",
          name: "fabric_exec",
          arguments: { code: "await omp.edit(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      outerResult("outer-transfer"),
      "outer-transfer",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"), {
      source: { provider: "openai-codex", modelId: "gpt-5.6-sol", api: "openai-responses" },
      target: {
        provider: "neuralwatt",
        modelId: "kimi-k3",
        api: "openai-completions",
        reasoning: true,
      },
    });
    const child = await SessionManager.open(sessionFile);

    const assistantMessage = child
      .buildSessionContext()
      .messages.find((message) => message.role === "assistant");
    const content = (assistantMessage as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(content).toContainEqual(
      expect.objectContaining({ type: "thinking", thinkingSignature: "reasoning_content" }),
    );
    expect(child.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "omp-fabric-handoff",
      data: {
        thinkingTransfer: {
          policy: "re-signed",
          translated: 1,
          dropped: 0,
          target: "neuralwatt/kimi-k3",
        },
      },
    });
    expect(source.getLeafId()).toBe(activeEntryId);
  });

  it("strips foreign thinking and appends a digest for an incompatible executor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the guard", timestamp: 1 });
    const activeEntryId = source.appendMessage(
      assistant([
        {
          type: "thinking",
          thinking: "**Plan the token guard**\n\nsteps",
          thinkingSignature: '{"id":"rs_blob","type":"reasoning","encrypted_content":"gAAA"}',
        },
        { type: "text", text: "Implementing now." },
        {
          type: "toolCall",
          id: "outer-strip",
          name: "fabric_exec",
          arguments: { code: "await omp.edit(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      outerResult("outer-strip"),
      "outer-strip",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"), {
      source: { provider: "openai-codex", modelId: "gpt-5.6-sol", api: "openai-responses" },
      target: {
        provider: "anthropic",
        modelId: "executor",
        api: "anthropic-messages",
        reasoning: true,
      },
    });
    const child = await SessionManager.open(sessionFile);

    const messages = child.buildSessionContext().messages;
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      expect(
        message.content.some((part) => (part as { type?: string }).type === "thinking"),
      ).toBe(false);
    }
    const digest = child
      .getEntries()
      .find((entry) => entry.type === "custom_message");
    expect(digest).toMatchObject({
      customType: "omp-fabric-handoff-thinking",
      display: false,
      details: { policy: "stripped", citedBlocks: 1 },
    });
    expect(JSON.stringify(digest)).toContain(`[entry ${activeEntryId}]`);
    expect(JSON.stringify(digest)).toContain("Plan the token guard");
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "omp-fabric-handoff",
      data: {
        sourceSessionId: source.getSessionId(),
        boundary: "fabric_exec_end",
        thinkingTransfer: {
          policy: "stripped",
          translated: 0,
          dropped: 1,
          target: "anthropic/executor",
        },
      },
    });
    expect(child.getHeader()?.parentSession).toBe(source.getSessionFile());
  });

  it("compacts the inherited trajectory with Fabric's deterministic compactor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the token guard 43117", timestamp: 1 });
    source.appendMessage(
      assistant([
        {
          type: "text",
          text: `Scratched src/token.ts internals at length. ${"filler ".repeat(30)}SCRATCH_TAIL_99231`,
        },
      ]),
    );
    const proceedEntryId = source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    source.appendMessage(
      assistant([
        { type: "text", text: "Continuing at the boundary." },
        {
          type: "toolCall",
          id: "outer-compact",
          name: "fabric_exec",
          arguments: { code: "await omp.edit(...);" },
        },
      ]),
    );

    const result = outerResult("outer-compact");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-compact",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"), undefined, {
      instructions: "Focus on the guard outcome.",
      preserve: ["Threshold is 90 percent of the context window"],
    });
    const child = await SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "toolResult",
    ]);
    const summary = JSON.stringify(messages[0]);
    expect(summary).toContain("[Session Goal]");
    expect(summary).toContain("Implement the token guard 43117");
    expect(summary).toContain("[Compaction Request]");
    expect(summary).toContain("Threshold is 90 percent of the context window");
    // Projected one-liners clip long scratch text out of the live context...
    expect(JSON.stringify(messages)).not.toContain("SCRATCH_TAIL_99231");
    // ...while the append-only file retains the raw branch underneath the compaction marker.
    expect(
      child.getEntries().some((entry) => JSON.stringify(entry).includes("SCRATCH_TAIL_99231")),
    ).toBe(true);
    const compactionEntry = child.getEntries().find((entry) => entry.type === "compaction");
    expect(compactionEntry).toMatchObject({
      type: "compaction",
      fromExtension: true,
      firstKeptEntryId: proceedEntryId,
    });
    expect(
      (compactionEntry as { details?: Record<string, unknown> } | undefined)?.details,
    ).toMatchObject({ compactor: "fabric", version: 2 });
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "omp-fabric-handoff",
      data: { compaction: { applied: true, firstKeptEntryId: proceedEntryId } },
    });
    expect(messages.at(-1)).toEqual(result);
  });

  it("applies the default compaction for a bare compact request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Preserve rare fact 43117", timestamp: 1 });
    source.appendMessage(
      assistant([{ type: "text", text: "Scratch exploration 99231." }]),
    );
    source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    source.appendMessage(
      assistant([
        {
          type: "toolCall",
          id: "outer-bare-compact",
          name: "fabric_exec",
          arguments: { code: "await omp.write(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      outerResult("outer-bare-compact"),
      "outer-bare-compact",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"), undefined, {});
    const child = await SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(messages[0])).not.toContain("[Compaction Request]");
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "omp-fabric-handoff",
      data: { compaction: { applied: true } },
    });
  });

  it("summarizes the whole trajectory when no turn boundary qualifies to keep", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage(
      assistant([
        { type: "text", text: "Single-turn scratch 99231." },
        {
          type: "toolCall",
          id: "outer-skip-compact",
          name: "fabric_exec",
          arguments: { code: "await omp.read(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      undefined,
      outerResult("outer-skip-compact"),
      "outer-skip-compact",
    );
    const sessionFile = await writeHandoffSession(seed, root, path.join(root, "child"), undefined, {});
    const child = await SessionManager.open(sessionFile);

    const compactionEntry = child.getEntries().find((entry) => entry.type === "compaction");
    expect(compactionEntry).toMatchObject({
      type: "compaction",
      fromExtension: true,
      firstKeptEntryId: "",
    });
    expect(child.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "toolResult",
    ]);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "omp-fabric-handoff",
      data: { compaction: { applied: true } },
    });
  });
});

describe("checkedHandoffCompaction", async () => {
  it("normalizes and bounds-checks the agents.handoff compact option", async () => {
    expect(checkedHandoffCompaction(undefined)).toBeUndefined();
    expect(checkedHandoffCompaction(false)).toBeUndefined();
    expect(checkedHandoffCompaction(true)).toEqual({});
    expect(checkedHandoffCompaction({ instructions: "x", preserve: ["a"] })).toEqual({
      instructions: "x",
      preserve: ["a"],
    });
    expect(() => checkedHandoffCompaction("yes")).toThrow(/must be true or an object/);
    expect(() => checkedHandoffCompaction({ instructions: 5 })).toThrow(
      /instructions must be a string/,
    );
    expect(() => checkedHandoffCompaction({ preserve: "a" })).toThrow(/array of strings/);
    expect(() => checkedHandoffCompaction({ instructions: "x".repeat(9 * 1024) })).toThrow(
      /exceed/,
    );
    expect(() =>
      checkedHandoffCompaction({
        preserve: Array.from({ length: 17 }, (_, index) => String(index)),
      })
    ).toThrow(/exceeds 16 items/);
  });
});
