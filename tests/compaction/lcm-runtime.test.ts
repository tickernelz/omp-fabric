import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { canonicalLcmPayload } from "../../src/storage/lcm-ledger.js";
import { LcmRuntime } from "../../src/compaction/lcm-runtime.js";
import { closeAfterTest, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";

const makeRoot = (): string => tempRoot("lcm-runtime-");
const openRuntime = (...args: ConstructorParameters<typeof LcmRuntime>): LcmRuntime => closeAfterTest(new LcmRuntime(...args), runtime => runtime.shutdown());
const makeEntry = (id: string, text: string, parentId: string | null = null): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
} as SessionEntry);
const makeContext = (root: string, entries: SessionEntry[], sessionFile?: string): ExtensionContext => ({
  cwd: root,
  model: undefined,
  modelRegistry: {} as ExtensionContext["modelRegistry"],
  sessionManager: {
    getRecordedCwd: () => root,
    getSessionFile: () => sessionFile,
    getSessionId: () => "session-1",
    getLeafId: () => "branch-a",
    getBranch: () => entries,
  },
} as unknown as ExtensionContext);

afterEach(releaseTemp);

describe("LCM runtime", () => {
  it("keys the ledger by recorded project identity", async () => {
    const liveRoot = makeRoot(); const recordedRoot = makeRoot(); const first = openRuntime(makeContext(liveRoot, []), { rootDir: liveRoot }); const secondContext = makeContext(liveRoot, []); secondContext.sessionManager.getRecordedCwd = () => recordedRoot; const second = openRuntime(secondContext, { rootDir: liveRoot });
    expect(first.projectKey).not.toBe(second.projectKey); await first.shutdown(); await second.shutdown();
  });
  it("rebinds a reused runtime to the newly selected session", async () => {
    const root = makeRoot(); const firstFile = path.join(root, "first.jsonl"); const secondFile = path.join(root, "second.jsonl"); const firstEntry = makeEntry("first", "first session"); const secondEntry = makeEntry("second", "second session"); const header = { type: "session", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" };
    fs.writeFileSync(firstFile, `${JSON.stringify({ ...header, id: "session-1" })}\n${JSON.stringify(firstEntry)}\n`); fs.writeFileSync(secondFile, `${JSON.stringify({ ...header, id: "session-2" })}\n${JSON.stringify(secondEntry)}\n`);
    let sessionId = "session-1"; let sessionFile = firstFile; let branch = [firstEntry]; const context = makeContext(root, branch, sessionFile); const manager = context.sessionManager as unknown as { getSessionId: () => string; getSessionFile: () => string; getBranch: () => SessionEntry[]; getLeafId: () => string };
    manager.getSessionId = () => sessionId; manager.getSessionFile = () => sessionFile; manager.getBranch = () => branch; manager.getLeafId = () => branch.at(-1)?.id ?? "";
    const runtime = openRuntime(context, { rootDir: root }); await runtime.reconcileSelectedSession(); sessionId = "session-2"; sessionFile = secondFile; branch = [secondEntry]; await runtime.reconcileSelectedSession();
    expect(runtime.memoryContext().currentSessionId).toBe("session-2"); expect("db" in runtime.memoryContext().ledger).toBe(false); expect("readOnly" in runtime.memoryContext().ledger).toBe(false); expect(runtime.raw("session-2")).toHaveLength(1); expect(runtime.raw("session-1")).toHaveLength(1); await runtime.shutdown();
  });
  it("reconciles only the selected old session and preserves full payload", async () => {
    const root = makeRoot();
    const selected = path.join(root, "selected.jsonl");
    const unrelated = path.join(root, "unrelated.jsonl");
    const entry = makeEntry("e1", "selected old session");
    const header = { type: "session", id: "session-1", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" };
    fs.writeFileSync(selected, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
    fs.writeFileSync(unrelated, `${JSON.stringify({ ...header, id: "session-2" })}\n${JSON.stringify(makeEntry("other", "must not import"))}\n`);
    const context = makeContext(root, [], selected);
    const runtime = openRuntime(context, { rootDir: root });
    await runtime.reconcileSelectedSession();
    const rows = runtime.raw("session-1");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual(JSON.parse(canonicalLcmPayload(entry)));
    expect(runtime.raw("session-2")).toHaveLength(0);
    await runtime.shutdown();
  });

  it("reads compaction options at use time so a settings change applies mid-session", async () => {
    const root = makeRoot();
    const entry = makeEntry("live", "live option source ".repeat(600));
    let outputChars = 4_096;
    const runtime = openRuntime(makeContext(root, [entry]), () => ({ rootDir: root, lcmMaxOutputChars: outputChars }));
    await runtime.readback();
    const wide = runtime.compact({ branchEntries: [entry], sessionId: "session-1", branch: "branch-a", firstKeptEntryId: "missing", tokensBefore: 100 });
    outputChars = 1_200;
    const narrow = runtime.compact({ branchEntries: [entry], sessionId: "session-1", branch: "branch-b", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(wide.source).toBe("emergency");
    expect(narrow.source).toBe("emergency");
    expect(Buffer.byteLength(narrow.summary, "utf8")).toBeLessThanOrEqual(1_200);
    expect(Buffer.byteLength(wide.summary, "utf8")).toBeGreaterThan(1_200);
    await runtime.shutdown();
  });

  it("keeps the session usable when reconciliation reports malformed rows", async () => {
    const root = makeRoot();
    const selected = path.join(root, "selected.jsonl");
    const entry = makeEntry("e1", "valid entry");
    const sessionHeader = { type: "session", id: "session-1", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" };
    fs.writeFileSync(selected, `${JSON.stringify({ type: "title", v: 1, title: "Resumed" })}\n${JSON.stringify(sessionHeader)}\n${JSON.stringify(entry)}\n{bad\n`);
    const runtime = openRuntime(makeContext(root, [], selected), { rootDir: root });
    await expect(runtime.reconcileSelectedSession()).resolves.toBeUndefined();
    expect(runtime.raw("session-1")).toHaveLength(1);
    expect(runtime.status).toBe("healthy");
    await runtime.shutdown();
  });

  it("keeps identical source ranges distinct across branches", async () => {
    const root = makeRoot(); const entry = makeEntry("shared", "shared source"); const runtime = openRuntime(makeContext(root, [entry]), { rootDir: root });
    const left = runtime.compact({ branchEntries: [entry], sessionId: "session-1", branch: "left", firstKeptEntryId: "missing", tokensBefore: 100 });
    const right = runtime.compact({ branchEntries: [entry], sessionId: "session-1", branch: "right", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(left.source).toBe("emergency"); expect(right.source).toBe("emergency"); expect(runtime.frontier("session-1", "left")).toHaveLength(1); expect(runtime.frontier("session-1", "right")).toHaveLength(1); expect(runtime.frontier("session-1", "left")[0]?.nodeId).not.toBe(runtime.frontier("session-1", "right")[0]?.nodeId); await runtime.shutdown();
  });
  it("uses the historical branch payload revision", async () => {
    const root = makeRoot();
    const historical = makeEntry("same-entry", "historical payload");
    const runtime = openRuntime(makeContext(root, [historical]), { rootDir: root });
    await runtime.readback();
    const newer = makeEntry("same-entry", "newer payload");
    runtime.ledger.appendRaw({ projectKey: runtime.projectKey, sessionId: "session-1", entryId: newer.id, role: "user", content: "newer payload", payloadJson: canonicalLcmPayload(newer) });
    const result = runtime.compact({ branchEntries: [historical], sessionId: "session-1", branch: "branch-a", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(result.summary).toContain("session-1/same-entry@1:");
    expect(result.summary).not.toContain("session-1/same-entry@2:");
    const stored = runtime.ledger.readRawEntry(runtime.projectKey, "session-1", "same-entry", 1);
    expect(stored?.payloadJson).toBe(canonicalLcmPayload(historical));
    await runtime.shutdown();
  });
  it("falls back when the ready frontier covers only part of the source range", async () => {
    const root = makeRoot(); const entries = [makeEntry("old", "old source"), makeEntry("new", "new source", "old")]; const runtime = openRuntime(makeContext(root, entries), { rootDir: root }); await runtime.readback();
    const rows = runtime.raw("session-1"); const leaf = runtime.maintenance.createLeaf([rows[0]!]); if (!leaf) throw new Error("expected leaf"); const job = runtime.maintenance.listJobs().find((item) => item.nodeId === leaf.nodeId); if (!job) throw new Error("expected job"); const claimed = runtime.maintenance.claim(job.jobId); runtime.maintenance.complete(claimed, { text: "partial summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" });
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", branch: "branch-a", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(result.source).toBe("emergency"); expect(result.summary).toContain("session-1/new@1:"); await runtime.shutdown();
  });
  it("persists new compaction entries before emitting provenance", async () => {
    const root = makeRoot();
    const entries = [makeEntry("new-entry", "new source ".repeat(1000))];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root, lcmMaxOutputChars: 1_024 });
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", branch: "branch-a", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(result.source).toBe("emergency");
    const stored = runtime.raw("session-1")[0];
    expect(stored?.revision).toBe(1);
    expect(result.summary).toContain("session-1/new-entry@1:");
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(1_024);
    expect(runtime.frontier("session-1", "branch-a")).toHaveLength(1);
    await runtime.shutdown();
    const restarted = openRuntime(makeContext(root, []), { rootDir: root });
    expect(restarted.frontier("session-1", "branch-a")[0]?.text).toBe(result.summary);
    await restarted.shutdown();
  });
  it("readbacks authoritative branch entries and returns a bounded emergency result", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "x".repeat(2000)), makeEntry("e2", "y".repeat(2000), "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const rows = runtime.raw("session-1");
    expect(rows).toHaveLength(2);
    const result = runtime.compact({
      branchEntries: entries,
      sessionId: "session-1",
      branch: "branch-a",
      firstKeptEntryId: "e2",
      tokensBefore: 9000,
    });
    expect(result.source).toBe("emergency");
    expect(result.firstKeptEntryId).toBe("e2");
    expect(result.tokensBefore).toBe(9000);
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(4096);
    expect(result.summary).toContain("Nonsemantic deterministic excerpt");
    await runtime.shutdown();
  });

  it("uses a ready frontier for the active session and branch", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "old source"), makeEntry("e2", "fresh tail", "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const rows = runtime.raw("session-1");
    const node = runtime.maintenance.createLeaf([rows[0]!]);
    if (!node) throw new Error("expected leaf");
    const job = runtime.maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
    if (!job) throw new Error("expected leaf job");
    const claimed = runtime.maintenance.claim(job.jobId);
    runtime.maintenance.complete(claimed, { text: "ready semantic summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" });
    const result = runtime.compact({
      branchEntries: entries,
      sessionId: "session-1",
      branch: "branch-a",
      firstKeptEntryId: "e2",
      tokensBefore: 9000,
    });
    expect(result.source).toBe("ready-frontier");
    expect(result.summary).toContain("ready semantic summary");
    expect(result.firstKeptEntryId).toBe("e2");
    await runtime.shutdown();
  });

  it("passes the recorded source revision to maintenance", async () => {
    const root = makeRoot();
    const first = makeEntry("same-id", "first revision");
    const context = makeContext(root, [first]);
    (context as unknown as { model: unknown }).model = { provider: "test", id: "summary", api: "openai-completions" };
    const runtime = openRuntime(context, { rootDir: root, maxCondenseChildren: 1 });
    await runtime.readback();
    const revisionOne = runtime.raw("session-1")[0];
    if (!revisionOne) throw new Error("expected first revision");
    const node = runtime.maintenance.createLeaf([revisionOne]);
    if (!node) throw new Error("expected leaf");
    const second = makeEntry("same-id", "second revision");
    runtime.ledger.appendRaw({ projectKey: runtime.projectKey, sessionId: "session-1", entryId: second.id, role: "user", content: "second revision", payloadJson: canonicalLcmPayload(second), createdAt: 0 });
    const revisionTwo = runtime.raw("session-1").find((entry) => entry.revision === 2);
    if (!revisionTwo) throw new Error("expected second revision");
    const replacement = runtime.maintenance.createLeaf([revisionTwo]);
    if (!replacement) throw new Error("expected replacement leaf");
    const replacementJob = runtime.maintenance.listJobs().find((job) => job.nodeId === replacement.nodeId);
    if (!replacementJob) throw new Error("expected replacement job");
    await runtime.maintenance.run(replacementJob, { modelHash: "test", generate: async () => ({ text: "replacement", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" }) }, revisionTwo.payloadJson);
    (runtime as unknown as { activeSources: Set<string> }).activeSources = new Set(runtime.raw("session-1").map((entry) => `${entry.sessionId}:${entry.entryId}:${entry.revision}`));
    const inputs: string[] = [];
    (runtime.maintenance as unknown as { run: (...args: unknown[]) => Promise<unknown> }).run = async (_job, _model, input) => { inputs.push(String(input)); return undefined; };
    await (runtime as unknown as { runMaintenance: () => Promise<void> }).runMaintenance();
    expect(inputs).toContain(revisionOne.payloadJson);
    await runtime.shutdown();
  });
  it("persists an emergency frontier when the summary model is unavailable", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "source")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await expect(runtime.syncAndSchedule()).resolves.toBeUndefined();
    await (runtime as unknown as { maintenancePending: Promise<void> }).maintenancePending;
    const frontier = runtime.frontier("session-1", "branch-a");
    expect(frontier).toHaveLength(1);
    expect(frontier[0]?.state).toBe("ready");
    expect(frontier[0]?.modelHash).toBe("emergency");
    expect(frontier[0]?.text).toContain("Nonsemantic deterministic excerpt");
    expect(runtime.maintenance.listJobs()[0]?.state).toBe("completed");
    await runtime.shutdown();
    await runtime.shutdown();
    await expect(runtime.readback()).resolves.toBeUndefined();
  });
});
