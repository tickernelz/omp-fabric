import { describe, expect, it } from "vitest";
import type { AgentSessionSeed } from "../src/agents/types.js";
import {
  RETIREMENT_MIN_BYTES,
  RETIREMENT_RECENCY_WINDOW,
  applyRetirement,
  planRetirement,
  retireHandoffSeed,
  type TranscriptEntry,
} from "../src/prewalk/retirement.js";

let sequence = 0;

const entry = (message: Record<string, unknown>): TranscriptEntry => {
  sequence += 1;
  return {
    type: "message",
    id: `entry-${sequence}`,
    parentId: sequence === 1 ? null : `entry-${sequence - 1}`,
    timestamp: new Date(sequence * 1000).toISOString(),
    message,
  } as unknown as TranscriptEntry;
};

const call = (id: string, name: string, args: Record<string, unknown>): TranscriptEntry =>
  entry({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "anthropic",
    provider: "anthropic",
    model: "planner",
    stopReason: "toolUse",
    timestamp: 1,
  });

const payload = (label: string, bytes: number): string => label.padEnd(bytes, ".");

const result = (
  id: string,
  toolName: string,
  text: string,
  overrides: Record<string, unknown> = {},
): TranscriptEntry =>
  entry({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
    ...overrides,
  });

const exploration = (
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  text: string,
  overrides: Record<string, unknown> = {},
): TranscriptEntry[] => [call(id, toolName, args), result(id, toolName, text, overrides)];

const enabled = { handoffRetirement: true } as const;

const messageOf = (entries: readonly TranscriptEntry[], id: string): Record<string, unknown> => {
  const found = entries.find((candidate) => (candidate as { id: string }).id === id);
  return (found as unknown as { message: Record<string, unknown> }).message;
};

const textOf = (entries: readonly TranscriptEntry[], id: string): string => {
  const content = messageOf(entries, id).content as { text: string }[];
  return content.map((block) => block.text).join("");
};

describe("planRetirement", () => {
  it("is a strict no-op while handoffRetirement is off", () => {
    const entries = [
      ...exploration("c1", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("c2", "read", { path: "src/b.ts" }, payload("b", 4_000)),
      ...exploration("c3", "read", { path: "src/c.ts" }, payload("c", 4_000)),
      ...exploration("c4", "read", { path: "src/d.ts" }, payload("d", 4_000)),
    ];

    const plan = planRetirement(entries, { recencyWindow: 0 });

    expect(plan).toEqual({
      enabled: false,
      candidates: 0,
      retired: [],
      bytesRetired: 0,
      markerBytes: 0,
    });
    expect(applyRetirement(entries, plan)).toBe(entries);
  });

  it("retires a stale successful read and leaves a recoverable marker in its place", () => {
    const entries = [
      ...exploration("stale", "read", { path: "src/deep/module.ts" }, payload("stale", 6_000)),
      ...exploration("recent", "read", { path: "src/recent.ts" }, payload("recent", 6_000)),
    ];

    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });

    expect(plan.retired).toHaveLength(1);
    expect(plan.retired[0]).toMatchObject({
      toolCallId: "stale",
      toolName: "read",
      target: "src/deep/module.ts",
      bytes: 6_000,
    });

    const applied = applyRetirement(entries, plan, 1_700);
    expect(applied).toHaveLength(entries.length);

    const staleId = plan.retired[0]!.entryId;
    const marker = textOf(applied, staleId);
    expect(marker).toContain("read");
    expect(marker).toContain("src/deep/module.ts");
    expect(marker).toContain("6000 bytes");
    expect(messageOf(applied, staleId)).toMatchObject({
      role: "toolResult",
      toolCallId: "stale",
      toolName: "read",
      prunedAt: 1_700,
    });
    expect(entries.map((item) => (item as { id: string }).id)).toEqual(
      applied.map((item) => (item as { id: string }).id),
    );
  });

  it("drops bulky details with the retired body and counts them as retired bytes", () => {
    const details = { lines: Array.from({ length: 200 }, (_, index) => `line ${index}`) };
    const detailBytes = Buffer.byteLength(JSON.stringify(details), "utf8");
    const entries = [
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 1_000), { details }),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 1_000)),
    ];

    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });

    expect(plan.retired[0]?.bytes).toBe(1_000 + detailBytes);
    const applied = applyRetirement(entries, plan);
    expect(messageOf(applied, plan.retired[0]!.entryId).details).toBeUndefined();
  });

  it("keeps a failed read", () => {
    const entries = [
      ...exploration("failed", "read", { path: "src/missing.ts" }, payload("boom", 4_000), {
        isError: true,
      }),
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];

    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });

    expect(plan.retired.map((item) => item.toolCallId)).toEqual(["stale"]);
  });

  it("keeps mutating tool results", () => {
    const entries = [
      ...exploration("edited", "edit", { path: "src/a.ts" }, payload("edit", 4_000)),
      ...exploration("written", "write", { path: "src/b.ts" }, payload("write", 4_000)),
      ...exploration("ran", "bash", { cmd: "npm test" }, payload("bash", 4_000)),
      ...exploration("stale", "grep", { pattern: "TODO", path: "src" }, payload("grep", 4_000)),
      ...exploration("recent", "ls", { path: "src" }, payload("ls", 4_000)),
    ];

    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });

    expect(plan.retired.map((item) => item.toolCallId)).toEqual(["stale"]);
    expect(plan.retired[0]?.target).toBe("TODO @ src");
  });

  it("keeps user messages and assistant reasoning", () => {
    const user = entry({
      role: "user",
      content: [{ type: "text", text: payload("ask", 4_000) }],
      toolName: "read",
      toolCallId: "impostor",
      isError: false,
      timestamp: 1,
    });
    const reasoning = entry({
      role: "assistant",
      content: [{ type: "thinking", thinking: payload("think", 4_000) }],
      api: "anthropic",
      provider: "anthropic",
      model: "planner",
      stopReason: "stop",
      timestamp: 1,
    });
    const entries = [
      user,
      reasoning,
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];

    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });
    const applied = applyRetirement(entries, plan);

    expect(plan.retired.map((item) => item.toolCallId)).toEqual(["stale"]);
    expect(applied[0]).toBe(user);
    expect(applied[1]).toBe(reasoning);
  });

  it("keeps the most recent results inside the recency window", () => {
    const entries = [
      ...exploration("c1", "read", { path: "src/1.ts" }, payload("1", 4_000)),
      ...exploration("c2", "read", { path: "src/2.ts" }, payload("2", 4_000)),
      ...exploration("c3", "read", { path: "src/3.ts" }, payload("3", 4_000)),
      ...exploration("c4", "read", { path: "src/4.ts" }, payload("4", 4_000)),
    ];

    const windowed = planRetirement(entries, enabled);
    expect(RETIREMENT_RECENCY_WINDOW).toBe(3);
    expect(windowed.candidates).toBe(4);
    expect(windowed.retired.map((item) => item.toolCallId)).toEqual(["c1"]);

    const widened = planRetirement(entries, { ...enabled, recencyWindow: 4 });
    expect(widened.retired).toEqual([]);
  });

  it("honours the shared config keep count when no explicit window is given", () => {
    const entries = [
      ...exploration("c1", "read", { path: "src/1.ts" }, payload("1", 4_000)),
      ...exploration("c2", "read", { path: "src/2.ts" }, payload("2", 4_000)),
      ...exploration("c3", "read", { path: "src/3.ts" }, payload("3", 4_000)),
    ];

    const kept = planRetirement(entries, { ...enabled, handoffRetirementKeep: 1 });
    expect(kept.retired.map((item) => item.toolCallId)).toEqual(["c1", "c2"]);

    const explicit = planRetirement(entries, {
      ...enabled,
      handoffRetirementKeep: 1,
      recencyWindow: 3,
    });
    expect(explicit.retired).toEqual([]);
  });

  it("keeps results below the size floor and image-bearing results", () => {
    const image = entry({
      role: "toolResult",
      toolCallId: "shot",
      toolName: "read",
      content: [
        { type: "text", text: payload("shot", 4_000) },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 2,
    });
    const entries = [
      ...exploration("tiny", "read", { path: "src/tiny.ts" }, "small"),
      call("shot", "read", { path: "screenshot.png" }),
      image,
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];

    expect(RETIREMENT_MIN_BYTES).toBe(512);
    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });

    expect(plan.retired.map((item) => item.toolCallId)).toEqual(["stale"]);
  });

  it("retires fabric-captured core tool results under their omp. prefix", () => {
    const entries = [
      ...exploration("stale", "omp.read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "omp.read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];

    const plan = planRetirement(entries, { ...enabled, recencyWindow: 1 });

    expect(plan.retired.map((item) => item.toolName)).toEqual(["read"]);
  });

  it("never retires the same result twice", () => {
    const entries = [
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];

    const once = applyRetirement(entries, planRetirement(entries, { ...enabled, recencyWindow: 1 }));
    const second = planRetirement(once, { ...enabled, recencyWindow: 0 });

    expect(second.retired.map((item) => item.toolCallId)).toEqual(["recent"]);
  });

  it("degrades to retiring nothing on malformed input instead of throwing", () => {
    const malformed = [
      null,
      undefined,
      42,
      "entry",
      { type: "message" },
      { type: "message", id: "x", message: null },
      { type: "message", id: "y", message: { role: "toolResult" } },
      { type: "message", id: "z", message: { role: "toolResult", toolName: "read", content: "raw", isError: false } },
      { type: "compaction", id: "c", summary: payload("s", 4_000) },
      { type: "custom_message", id: "m", customType: "x", content: payload("m", 4_000) },
    ] as unknown as TranscriptEntry[];

    expect(() => planRetirement(malformed, enabled)).not.toThrow();
    const plan = planRetirement(malformed, { ...enabled, recencyWindow: 0 });
    expect(plan.retired).toEqual([]);
    expect(applyRetirement(malformed, plan)).toBe(malformed);
    expect(planRetirement(undefined, enabled).retired).toEqual([]);
    expect(
      planRetirement("not an array" as unknown as TranscriptEntry[], enabled).retired,
    ).toEqual([]);
  });

  it("passes unknown entry shapes through applyRetirement untouched", () => {
    const foreign = { type: "model_change", id: "mc", model: "a/b" } as unknown as TranscriptEntry;
    const entries = [
      foreign,
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];

    const applied = applyRetirement(entries, planRetirement(entries, { ...enabled, recencyWindow: 1 }));

    expect(applied[0]).toBe(foreign);
  });

  it("retires a realistic planning transcript down to markers", () => {
    const files = [
      "src/prewalk/handoff.ts",
      "src/prewalk/controller.ts",
      "src/agents/handoff.ts",
      "src/agents/manager.ts",
      "src/config.ts",
      "src/index.ts",
    ];
    const bodies = files.map((file, index) => payload(file, 4_096 + index * 512));
    const entries = files.flatMap((file, index) =>
      exploration(`read-${index}`, "read", { path: file }, bodies[index]!),
    );

    const plan = planRetirement(entries, enabled);
    const expectedBytes = bodies
      .slice(0, files.length - RETIREMENT_RECENCY_WINDOW)
      .reduce((total, body) => total + body.length, 0);

    expect(plan.candidates).toBe(6);
    expect(plan.retired).toHaveLength(3);
    expect(plan.bytesRetired).toBe(expectedBytes);
    expect(plan.bytesRetired).toBe(13_824);
    expect(plan.markerBytes).toBeLessThan(500);

    const applied = applyRetirement(entries, plan);
    const before = entries.reduce((total, item) => total + JSON.stringify(item).length, 0);
    const after = applied.reduce((total, item) => total + JSON.stringify(item).length, 0);
    expect(before - after).toBeGreaterThan(plan.bytesRetired - plan.markerBytes - 200);
    expect(before - after).toBeLessThan(plan.bytesRetired);
  });
});

const seed = (branch?: TranscriptEntry[]): AgentSessionSeed =>
  ({
    sourceSessionId: "session-1",
    sourceBranchLeafId: "leaf",
    ...(branch ? { sourceBranch: branch } : { sourceSessionFile: "/tmp/session.jsonl" }),
    outerToolResult: {
      role: "toolResult",
      toolCallId: "outer",
      toolName: "fabric_exec",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 9,
    },
  }) as unknown as AgentSessionSeed;

describe("retireHandoffSeed", () => {
  it("prunes the in-memory branch the executor inherits", () => {
    const branch = [
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];
    const source = seed(branch);

    const outcome = retireHandoffSeed(source, { ...enabled, recencyWindow: 1 });

    expect(outcome.plan.retired).toHaveLength(1);
    expect(outcome.seed).not.toBe(source);
    expect(source.sourceBranch).toBe(branch);
    expect(textOf(outcome.seed.sourceBranch!, outcome.plan.retired[0]!.entryId)).toContain(
      "src/a.ts",
    );
  });

  it("returns the seed untouched when the option is off or no branch travels with it", () => {
    const branch = [
      ...exploration("stale", "read", { path: "src/a.ts" }, payload("a", 4_000)),
      ...exploration("recent", "read", { path: "src/b.ts" }, payload("b", 4_000)),
    ];
    const withBranch = seed(branch);
    const fileBacked = seed();

    const off = retireHandoffSeed(withBranch, { recencyWindow: 0 });
    expect(off.seed).toBe(withBranch);
    expect(off.plan.enabled).toBe(false);
    expect(off.plan.retired).toEqual([]);

    const persisted = retireHandoffSeed(fileBacked, { ...enabled, recencyWindow: 0 });
    expect(persisted.seed).toBe(fileBacked);
    expect(persisted.plan.retired).toEqual([]);
  });
});
