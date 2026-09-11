import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { canonicalLcmPayload } from "../../src/storage/lcm-ledger.js";
import { LcmRuntime, renderAddressedFrontier } from "../../src/compaction/lcm-runtime.js";
import { LCM_RECOVERY_POINTER } from "../../src/compaction/render.js";
import { MAX_SUMMARY_BYTES } from "../../src/compaction/bounds.js";
import type { LcmJob } from "../../src/compaction/lcm-maintenance.js";
import { closeAfterTest, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";

const makeRoot = (): string => tempRoot("lcm-runtime-");
const openRuntime = (...args: ConstructorParameters<typeof LcmRuntime>): LcmRuntime => closeAfterTest(new LcmRuntime(...args), runtime => runtime.shutdown());
const inputFor = (text: string): number => Buffer.byteLength(text, "utf8") + 1;
const bigNode = (index: number, textBytes: number) => ({
  nodeId: `node-${String(index).padStart(4, "0")}-${"a".repeat(24)}`,
  projectKey: "p",
  sessionId: "01a07992-68c4-727f-83c8-0da305a77919",
  branch: "branch-a",
  kind: "leaf" as const,
  sources: Array.from({ length: 6 }, (_, position) => ({
    sessionId: "01a07992-68c4-727f-83c8-0da305a77919",
    entryId: `01a07992-68c4-727f-83c8-0da305a7${String(position).padStart(4, "0")}`,
    revision: 1,
    payloadHash: "f".repeat(64),
  })),
  children: [] as string[],
  depth: 0,
  sourceHash: "h",
  policyHash: "p",
  modelHash: "m",
  state: "ready" as const,
  text: `summary ${index} ${"z".repeat(textBytes)}`,
  createdAt: 0,
});
const makeEntry = (id: string, text: string, parentId: string | null = null): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
} as SessionEntry);
const writeSession = (root: string, name: string): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "session-1", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" })}\n${JSON.stringify(makeEntry("e1", "source"))}\n`);
  return file;
};
const failReads = () => vi.spyOn(fs, "readSync").mockImplementation((() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }) as typeof fs.readSync);
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

const settle = (runtime: LcmRuntime): Promise<void> => (runtime as unknown as { maintenancePending: Promise<void> }).maintenancePending;
const historyEntry = (runtime: LcmRuntime, index: number) => runtime.ledger.appendRaw({
  projectKey: runtime.projectKey,
  sessionId: "history-session",
  entryId: `h${index}`,
  role: "user",
  content: `history ${index}`,
  payloadJson: canonicalLcmPayload(makeEntry(`h${index}`, `history ${index}`)),
  parentEntryId: null,
  branch: "history",
});

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

  it("packs a leaf up to the input budget instead of clipping evidence", async () => {
    const root = makeRoot();
    const small = Array.from({ length: 40 }, (_, index) => makeEntry("s" + index, "small source " + index, index === 0 ? null : "s" + (index - 1)));
    const runtime = openRuntime(makeContext(root, small), { rootDir: root, maxLeafEntries: 32, lcmMaxInputChars: 4_000 });
    await runtime.readback();
    const rows = runtime.raw("session-1");

    const packed = runtime.maintenance.selectLeaf(rows);
    const packedChars = packed.reduce((total, entry) => total + entry.payloadJson.length, 0);
    expect(packed.length).toBeGreaterThan(1);
    expect(packed.length).toBeLessThan(32);
    expect(packedChars).toBeLessThanOrEqual(4_000);

    const oversized = runtime.maintenance.selectLeaf([{ ...rows[0]!, payloadJson: "x".repeat(9_000) }]);
    expect(oversized).toHaveLength(1);
    await runtime.shutdown();
  });

  it("calls the model without a limit until one is configured", async () => {
    const root = makeRoot();
    const runtime = openRuntime(makeContext(root, [makeEntry("a", "unlimited source")]), { rootDir: root });
    const budget = runtime.maintenance.budgetPolicy();
    expect(budget.calls).toBe(Number.POSITIVE_INFINITY);
    expect(budget.sessionCalls).toBe(Number.POSITIVE_INFINITY);
    expect(budget.wallMs).toBe(Number.POSITIVE_INFINITY);
    await runtime.shutdown();
  });

  it("upgrades a deterministic node once the model answers again", async () => {
    const root = makeRoot();
    const entries = [makeEntry("a", "first source"), makeEntry("b", "second source", "a")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const rows = runtime.raw("session-1");
    const leaf = runtime.maintenance.createLeaf(rows);
    const job = runtime.maintenance.listJobs().find((item) => item.nodeId === leaf?.nodeId);
    runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(job!.jobId), "[Nonsemantic deterministic excerpt; not a model summary]\nfallback");
    expect(runtime.maintenance.getNode(leaf!.nodeId)?.modelHash).toBe("emergency");
    expect(runtime.maintenance.selectUpgrades("session-1", undefined, 5).map((node) => node.nodeId)).toEqual([leaf!.nodeId]);

    const reopened = runtime.maintenance.reopen(leaf!.nodeId);
    const claimed = runtime.maintenance.claim(reopened.jobId);
    const upgraded = runtime.maintenance.complete(claimed, { text: "a real model summary", inputTokens: 10, outputTokens: 5, cost: 0, wallMs: 12, modelHash: "model-abc" }, inputFor("a real model summary"));

    expect(upgraded.nodeId).toBe(leaf!.nodeId);
    expect(upgraded.text).toBe("a real model summary");
    expect(upgraded.modelHash).toBe("model-abc");
    expect(runtime.maintenance.selectUpgrades("session-1", undefined, 5)).toHaveLength(0);
    expect(() => runtime.maintenance.reopen(leaf!.nodeId)).toThrow("node already carries a model summary");
    await runtime.shutdown();
  });

  it("previews the served summary without writing to the ledger", async () => {
    const root = makeRoot();
    const entries = [makeEntry("a", "first source"), makeEntry("b", "second source", "a")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root, maxLeafEntries: 2 });
    await runtime.readback();
    const rows = runtime.raw("session-1");
    const leaf = runtime.maintenance.createLeaf(rows)!;
    const job = runtime.maintenance.listJobs().find((item) => item.nodeId === leaf.nodeId);
    runtime.maintenance.complete(runtime.maintenance.claim(job!.jobId), { text: "served summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "model-1" }, inputFor("served summary"));

    const before = { nodes: runtime.maintenance.listNodes(1_000).length, raw: runtime.raw("session-1").length };
    const preview = runtime.preview();
    const map = runtime.coverageMap();
    const after = { nodes: runtime.maintenance.listNodes(1_000).length, raw: runtime.raw("session-1").length };

    expect(preview.text).toBe("served summary");
    expect(preview.nodes).toBe(1);
    expect(preview.coveredSources).toBe(2);
    expect(preview.summaryBytes).toBe(Buffer.byteLength("served summary", "utf8"));
    expect(preview.sourceBytes).toBeGreaterThan(preview.summaryBytes);
    expect(map.filter((entry) => entry.covered)).toHaveLength(2);
    expect(after).toEqual(before);
    await runtime.shutdown();
  });

  it("keeps the replaced text when a node is upgraded", async () => {
    const root = makeRoot();
    const runtime = openRuntime(makeContext(root, [makeEntry("a", "only source")]), { rootDir: root, maxLeafEntries: 1 });
    await runtime.readback();
    const leaf = runtime.maintenance.createLeaf(runtime.raw("session-1"))!;
    const first = runtime.maintenance.listJobs().find((item) => item.nodeId === leaf.nodeId);
    runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(first!.jobId), "[excerpt] original");
    const upgrade = runtime.maintenance.reopen(leaf.nodeId);
    runtime.maintenance.complete(runtime.maintenance.claim(upgrade.jobId), { text: "model summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "model-1" }, inputFor("model summary"));

    const detail = runtime.node(leaf.nodeId)!;
    expect(detail.node.text).toBe("model summary");
    expect(detail.revisions.map((entry) => entry.text)).toEqual(["[excerpt] original"]);
    expect(detail.revisions[0]?.modelHash).toBe("emergency");
    await runtime.shutdown();
  });

  it("rebuilds a condensed parent after upgrading the excerpt it was built from", async () => {
    const root = makeRoot();
    const entries = [makeEntry("a", "first source"), makeEntry("b", "second source", "a")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root, maxLeafEntries: 1, maxCondenseChildren: 2 });
    await runtime.readback();
    const excerpt = (nodeId: string): void => {
      const job = runtime.maintenance.listJobs().find((item) => item.nodeId === nodeId && item.state === "pending");
      runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(job!.jobId), "[excerpt] " + nodeId.slice(0, 8));
    };
    const rows = runtime.raw("session-1");
    const leaves = rows.map((row) => {
      const node = runtime.maintenance.createLeaf([row])!;
      excerpt(node.nodeId);
      return runtime.maintenance.getNode(node.nodeId)!;
    });
    const parent = runtime.maintenance.createCondensed(leaves)!;
    const parentJob = runtime.maintenance.listJobs().find((item) => item.nodeId === parent.nodeId);
    runtime.maintenance.complete(runtime.maintenance.claim(parentJob!.jobId), { text: "parent built from excerpts", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "model-1" }, inputFor("parent built from excerpts"));

    expect(runtime.maintenance.ancestorsOf(leaves[0]!.nodeId)).toEqual([parent.nodeId]);

    const upgrade = runtime.maintenance.reopen(leaves[0]!.nodeId);
    runtime.maintenance.complete(runtime.maintenance.claim(upgrade.jobId), { text: "upgraded leaf", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "model-2" }, inputFor("upgraded leaf"));
    for (const ancestor of runtime.maintenance.ancestorsOf(leaves[0]!.nodeId)) runtime.maintenance.reopen(ancestor, true);

    const refresh = runtime.maintenance.listJobs().find((item) => item.nodeId === parent.nodeId && item.state === "pending");
    expect(refresh).toBeDefined();
    runtime.maintenance.complete(runtime.maintenance.claim(refresh!.jobId), { text: "parent rebuilt from the upgraded leaf", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "model-2" }, inputFor("parent rebuilt from the upgraded leaf"));
    expect(runtime.maintenance.getNode(parent.nodeId)?.text).toBe("parent rebuilt from the upgraded leaf");
    await runtime.shutdown();
  });

  it("spends the configured model wall-time budget before falling back", async () => {
    const spend = (runtime: LcmRuntime, wallMs: number): void => {
      runtime.ledger.transaction((db) => {
        db.prepare("INSERT INTO maintenance_usage(project_key,day,session_id,calls,input_tokens,output_tokens,cost,wall_ms) VALUES(?,?,?,?,?,?,?,?)")
          .run(runtime.projectKey, new Date().toISOString().slice(0, 10), "session-1", 4, 82_261, 3_952, 0, wallMs);
      });
    };
    const claimAfterSpending = async (wallMs: number, maxDailyModelSeconds: number): Promise<string | undefined> => {
      const root = makeRoot();
      const entries = [makeEntry("a", "budget source a"), makeEntry("b", "budget source b")];
      const runtime = openRuntime(makeContext(root, entries), { rootDir: root, maxDailyModelSeconds });
      await runtime.readback();
      spend(runtime, wallMs);
      const leaf = runtime.maintenance.createLeaf(runtime.raw("session-1"));
      const job = runtime.maintenance.listJobs().find((item) => item.nodeId === leaf?.nodeId);
      let failure: string | undefined;
      try {
        const claimed = runtime.maintenance.claim(job!.jobId);
        runtime.maintenance.complete(claimed, { text: "summary", inputTokens: 20_000, outputTokens: 900, cost: 0, wallMs: 13_800, modelHash: "test" }, inputFor("summary"));
      } catch (error) { failure = (error as Error).message; }
      await runtime.shutdown();
      return failure;
    };

    expect(await claimAfterSpending(55_110, 60)).toBe("budget exhausted");
    expect(await claimAfterSpending(55_110, 900)).toBeUndefined();
  });

  it("bounds maintenance work by its own pass budget, not the condensation fan-in", async () => {
    const settle = async (runtime: LcmRuntime): Promise<number> => {
      let previous = -1;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const count = runtime.maintenance.listNodes(1_000).length;
        if (count === previous) return count;
        previous = count;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return runtime.maintenance.listNodes(1_000).length;
    };
    const entries = Array.from({ length: 40 }, (_, index) =>
      makeEntry("e" + index, "maintenance source " + index, index === 0 ? null : "e" + (index - 1)));

    const singlePass = makeRoot();
    const single = openRuntime(makeContext(singlePass, entries), {
      rootDir: singlePass,
      maxLeafEntries: 8,
      maxCondenseChildren: 8,
      maxMaintenancePasses: 1,
    });
    await single.syncAndSchedule();
    expect(await settle(single)).toBe(1);
    await single.shutdown();

    const manyPasses = makeRoot();
    const many = openRuntime(makeContext(manyPasses, entries), {
      rootDir: manyPasses,
      maxLeafEntries: 8,
      maxCondenseChildren: 8,
      maxMaintenancePasses: 3,
    });
    await many.syncAndSchedule();
    expect(await settle(many)).toBe(3);
    await many.shutdown();
  });

  it("reads compaction options at use time so a settings change applies mid-session", async () => {
    const root = makeRoot();
    const first = makeEntry("live-first", "live option source ".repeat(600));
    const second = makeEntry("live-second", "later option source ".repeat(600), "live-first");
    let outputChars = 4_096;
    const runtime = openRuntime(makeContext(root, [first, second]), () => ({ rootDir: root, lcmMaxOutputChars: outputChars }));
    await runtime.readback();
    const wide = runtime.compact({ branchEntries: [first], sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });
    outputChars = 1_200;
    const narrow = runtime.compact({ branchEntries: [second], sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });
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

  it("reports a reconciliation that dropped entries as degraded", async () => {
    const root = makeRoot();
    const file = path.join(root, "dropped.jsonl");
    const header = { type: "session", id: "session-1", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" };
    const kept = makeEntry("kept", "kept entry");
    const oversized = JSON.stringify({ ...makeEntry("huge", ""), message: { role: "user", content: [{ type: "text", text: "x".repeat(9 * 1024 ** 2) }] } });
    fs.writeFileSync(file, `${JSON.stringify(header)}\n${oversized}\n${JSON.stringify(kept)}\n`);

    const runtime = openRuntime(makeContext(root, [kept], file), { rootDir: root });
    await runtime.reconcileSelectedSession();

    expect(runtime.raw("session-1")).toHaveLength(1);
    expect(runtime.status).toBe("degraded");
    const reconciliation = runtime.report().reconciliation;
    expect(reconciliation?.degraded).toBe(true);
    expect(reconciliation?.drops.oversizedLines).toBe(1);
    expect(reconciliation?.drops.entries).toBe(1);
    expect(reconciliation?.reasons.join("; ")).toContain("skipped as oversized");
    expect(runtime.report().degraded).toContain("skipped as oversized");

    await runtime.readback();
    expect(runtime.status).toBe("degraded");
    await runtime.shutdown();
  });

  it("clears the reconciliation report once a session imports whole", async () => {
    const root = makeRoot();
    const file = path.join(root, "clean.jsonl");
    const header = { type: "session", id: "session-1", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" };
    const entry = makeEntry("kept", "kept entry");
    fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);

    const runtime = openRuntime(makeContext(root, [entry], file), { rootDir: root });
    await runtime.reconcileSelectedSession();

    expect(runtime.status).toBe("healthy");
    expect(runtime.report().reconciliation?.degraded).toBe(false);
    expect(runtime.report().reconciliation?.reasons).toEqual([]);
    expect(runtime.report().degraded).toBeUndefined();
    await runtime.shutdown();
  });

  it("reuses one summary for an identical source range instead of minting a second", async () => {
    const root = makeRoot();
    const entry = makeEntry("shared", "shared source");
    const runtime = openRuntime(makeContext(root, [entry]), { rootDir: root });

    const first = runtime.compact({ branchEntries: [entry], sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });
    const second = runtime.compact({ branchEntries: [entry], sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });

    expect(first.source).toBe("emergency");
    expect(second.source).toBe("ready-frontier");
    expect(runtime.frontier("session-1")).toHaveLength(1);
    await runtime.shutdown();
  });

  it("keeps a summary usable as the branch tip advances and drops it after a rewind", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "one"), makeEntry("e2", "two", "e1")];
    let leaf = "e2";
    const context = makeContext(root, entries);
    context.sessionManager.getLeafId = () => leaf;
    const runtime = openRuntime(context, { rootDir: root });
    await runtime.readback();
    const node = runtime.maintenance.createLeaf(runtime.ledger.readRaw(runtime.projectKey, "session-1"));
    if (!node) throw new Error("missing node");
    const job = runtime.maintenance.jobForNode(node.nodeId);
    if (!job) throw new Error("missing job");
    runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(job.jobId), "summary of both");

    expect(runtime.coverage()).toEqual({ active: 2, covered: 2 });

    entries.push(makeEntry("e3", "three", "e2"));
    leaf = "e3";
    await runtime.readback();

    expect(runtime.coverage()).toEqual({ active: 3, covered: 2 });
    expect(runtime.frontier("session-1")).toHaveLength(1);

    entries.splice(1);
    leaf = "e1";
    await runtime.readback();

    expect(runtime.frontier("session-1")).toHaveLength(0);
    expect(runtime.coverage()).toEqual({ active: 1, covered: 0 });
    await runtime.shutdown();
  });
  it("uses the historical branch payload revision", async () => {
    const root = makeRoot();
    const historical = makeEntry("same-entry", "historical payload");
    const runtime = openRuntime(makeContext(root, [historical]), { rootDir: root });
    await runtime.readback();
    const newer = makeEntry("same-entry", "newer payload");
    runtime.ledger.appendRaw({ projectKey: runtime.projectKey, sessionId: "session-1", entryId: newer.id, role: "user", content: "newer payload", payloadJson: canonicalLcmPayload(newer) });
    const result = runtime.compact({ branchEntries: [historical], sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(result.summary).toContain("lcm.raw:session-1:same-entry:1");
    expect(result.summary).not.toContain("lcm.raw:session-1:same-entry:2");
    const stored = runtime.ledger.readRawEntry(runtime.projectKey, "session-1", "same-entry", 1);
    expect(stored?.payloadJson).toBe(canonicalLcmPayload(historical));
    await runtime.shutdown();
  });
  it("falls back when the ready frontier covers only part of the source range", async () => {
    const root = makeRoot(); const entries = [makeEntry("old", "old source"), makeEntry("new", "new source", "old")]; const runtime = openRuntime(makeContext(root, entries), { rootDir: root }); await runtime.readback();
    const rows = runtime.raw("session-1"); const leaf = runtime.maintenance.createLeaf([rows[0]!]); if (!leaf) throw new Error("expected leaf"); const job = runtime.maintenance.listJobs().find((item) => item.nodeId === leaf.nodeId); if (!job) throw new Error("expected job"); const claimed = runtime.maintenance.claim(job.jobId); runtime.maintenance.complete(claimed, { text: "partial summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" }, inputFor("partial summary"));
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(result.source).toBe("emergency");
    const addressed = /sources: (.+)/.exec(result.summary)?.[1] ?? "";
    const listed = addressed.split(", ").filter((part) => part.startsWith("lcm.raw:session-1:")).length;
    const omitted = Number(/\+(\d+) more/.exec(addressed)?.[1] ?? 0);
    expect(listed + omitted).toBe(2);
    await runtime.shutdown();
  });
  it("persists new compaction entries before emitting provenance", async () => {
    const root = makeRoot();
    const entries = [makeEntry("new-entry", "new source ".repeat(1000))];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root, lcmMaxOutputChars: 1_024 });
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 100 });
    expect(result.source).toBe("emergency");
    const stored = runtime.raw("session-1")[0];
    expect(stored?.revision).toBe(1);
    expect(result.summary).toContain("lcm.raw:session-1:new-entry:1");
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(1_024);
    expect(runtime.frontier("session-1")).toHaveLength(1);
    await runtime.shutdown();
    const restarted = openRuntime(makeContext(root, []), { rootDir: root });
    expect(restarted.frontier("session-1")[0]?.text).toBe(result.summary);
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
    const head = runtime.raw("session-1").find((row) => row.entryId === "e1");
    if (!head) throw new Error("expected persisted head entry");
    const node = runtime.maintenance.createLeaf([head]);
    if (!node) throw new Error("expected leaf");
    const job = runtime.maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
    if (!job) throw new Error("expected leaf job");
    const claimed = runtime.maintenance.claim(job.jobId);
    runtime.maintenance.complete(claimed, { text: "ready semantic summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" }, inputFor("ready semantic summary"));
    const result = runtime.compact({
      branchEntries: entries,
      sessionId: "session-1",
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
    const frontier = runtime.frontier("session-1");
    expect(frontier).toHaveLength(1);
    expect(frontier[0]?.state).toBe("ready");
    expect(frontier[0]?.modelHash).toBe("emergency");
    expect(frontier[0]?.text).toContain("Nonsemantic deterministic excerpt");
    expect(runtime.maintenance.listJobs()[0]?.state).toBe("completed");
    await runtime.shutdown();
    await runtime.shutdown();
    await expect(runtime.readback()).resolves.toBeUndefined();
  });

  it("addresses every frontier node and its raw sources", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "old source"), makeEntry("e2", "fresh tail", "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const head = runtime.raw("session-1").find((row) => row.entryId === "e1");
    if (!head) throw new Error("expected persisted head entry");
    const node = runtime.maintenance.createLeaf([head]);
    if (!node) throw new Error("expected leaf");
    const job = runtime.maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
    if (!job) throw new Error("expected leaf job");
    runtime.maintenance.complete(runtime.maintenance.claim(job.jobId), { text: "ready semantic summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" }, inputFor("ready semantic summary"));
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", firstKeptEntryId: "e2", tokensBefore: 9000 });
    expect(result.source).toBe("ready-frontier");
    const frontier = runtime.frontier("session-1");
    expect(frontier.length).toBeGreaterThan(0);
    for (const rendered of frontier) expect(result.summary).toContain(`lcm.summary:${rendered.nodeId}`);
    expect(result.summary).toContain(`lcm.raw:session-1:e1:${head.revision}`);
    expect(result.summary.split(LCM_RECOVERY_POINTER)).toHaveLength(2);
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    await runtime.shutdown();
  });

  it("includes custom instructions and preserve items in ready frontier compaction", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "old source"), makeEntry("e2", "fresh tail", "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const head = runtime.raw("session-1").find((row) => row.entryId === "e1");
    if (!head) throw new Error("expected persisted head entry");
    const node = runtime.maintenance.createLeaf([head]);
    if (!node) throw new Error("expected leaf");
    const job = runtime.maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
    if (!job) throw new Error("expected leaf job");
    runtime.maintenance.complete(runtime.maintenance.claim(job.jobId), { text: "ready semantic summary", inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" }, inputFor("ready semantic summary"));
    const instructions = "__omp_fabric_compact_request_v1__:{\"version\":1,\"instructions\":\"Keep the API auth context\",\"preserve\":[\"src/auth.ts\"]}";
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", firstKeptEntryId: "e2", tokensBefore: 9000, customInstructions: instructions });
    expect(result.source).toBe("ready-frontier");
    expect(result.summary).toContain("[Compaction Request]");
    expect(result.summary).toContain("Keep the API auth context");
    expect(result.summary).toContain("src/auth.ts [preserve:0]");
    expect(result.details).toMatchObject({ instructionPolicy: { preserveCount: 1 } });
    await runtime.shutdown();
  });

  it("includes custom instructions and preserve items in emergency fallback compaction", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "emergency source"), makeEntry("e2", "fresh tail", "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const instructions = "__omp_fabric_compact_request_v1__:{\"version\":1,\"instructions\":\"Remember critical invariant\",\"preserve\":[\"src/invariant.ts\"]}";
    const result = runtime.compact({ branchEntries: entries, sessionId: "session-1", firstKeptEntryId: "missing", tokensBefore: 9000, customInstructions: instructions });
    expect(result.source).toBe("emergency");
    expect(result.summary).toContain("[Compaction Request]");
    expect(result.summary).toContain("Remember critical invariant");
    expect(result.summary).toContain("src/invariant.ts [preserve:0]");
    expect(result.details).toMatchObject({ instructionPolicy: { preserveCount: 1 } });
    await runtime.shutdown();
  });

  it("withholds whole frontier nodes past the byte bound and keeps every address resolvable", () => {
    const frontier = Array.from({ length: 6 }, (_, index) => bigNode(index, 11_600));
    const rendered = renderAddressedFrontier(frontier as unknown as Parameters<typeof renderAddressedFrontier>[0]);
    const sourceBytes = frontier.reduce((total, node) => total + Buffer.byteLength(node.text, "utf8"), 0);

    expect(sourceBytes).toBeGreaterThan(MAX_SUMMARY_BYTES * 2);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(rendered.split(LCM_RECOVERY_POINTER)).toHaveLength(2);
    expect(rendered.endsWith(LCM_RECOVERY_POINTER)).toBe(true);

    const known = new Set(frontier.map((node) => `lcm.summary:${node.nodeId}`));
    const emitted = [...rendered.matchAll(/lcm\.summary:[^\s,]+/g)].map((match) => match[0]);
    expect(emitted.length).toBe(frontier.length);
    for (const address of emitted) expect(known).toContain(address);
    for (const address of [...rendered.matchAll(/lcm\.raw:[^\s,]+/g)].map((match) => match[0])) {
      expect(address).toMatch(/^lcm\.raw:[0-9a-f-]+:[0-9a-f-]+:\d+$/);
    }

    const kept = frontier.filter((node) => rendered.includes(`address: lcm.summary:${node.nodeId}`));
    const withheld = frontier.filter((node) => !kept.includes(node));
    expect(kept.length).toBeGreaterThan(0);
    expect(withheld.length).toBeGreaterThan(0);
    for (const node of kept) expect(rendered).toContain(node.text);
    for (const node of withheld) expect(rendered).not.toContain(node.text);

    const notice = rendered.split("\n").find((line) => line.startsWith("… withheld")) ?? "";
    expect(notice).toContain(`withheld ${withheld.length} frontier nodes`);
    for (const node of withheld) expect(notice).toContain(`lcm.summary:${node.nodeId}`);
  });

  it("clips a single oversized node instead of serving a pointer with no summary", () => {
    const rendered = renderAddressedFrontier([bigNode(0, 70_000)] as unknown as Parameters<typeof renderAddressedFrontier>[0]);
    const bytes = Buffer.byteLength(rendered, "utf8");

    expect(bytes).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(bytes).toBeGreaterThan(MAX_SUMMARY_BYTES - 512);
    expect(rendered.endsWith(LCM_RECOVERY_POINTER)).toBe(true);
    expect(rendered).toContain("summary 0 ");
    expect(rendered).toContain("z".repeat(20_000));
    expect(rendered).toContain(`address: lcm.summary:${bigNode(0, 1).nodeId}`);
  });

  it("renders summary text for a node sized at the default output bound in multibyte script", () => {
    const text = "記".repeat(16_384);
    const node = { ...bigNode(0, 1), text };
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_SUMMARY_BYTES);
    expect([...text].length).toBe(16_384);

    const rendered = renderAddressedFrontier([node] as unknown as Parameters<typeof renderAddressedFrontier>[0]);
    const bytes = Buffer.byteLength(rendered, "utf8");

    expect(bytes).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(bytes).toBeGreaterThan(MAX_SUMMARY_BYTES - 512);
    expect(rendered).toContain("記".repeat(5_000));
    expect(rendered).not.toContain("\uFFFD");
    expect(rendered).toContain(`address: lcm.summary:${node.nodeId}`);
    expect(rendered.endsWith(LCM_RECOVERY_POINTER)).toBe(true);
  });

  it("skips one oversized node and still renders the smaller nodes behind it", () => {
    const frontier = [bigNode(0, 40_000), bigNode(1, 120), bigNode(2, 100)];
    const rendered = renderAddressedFrontier(frontier as unknown as Parameters<typeof renderAddressedFrontier>[0]);

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(rendered.endsWith(LCM_RECOVERY_POINTER)).toBe(true);
    expect(rendered).toContain(frontier[1]!.text);
    expect(rendered).toContain(frontier[2]!.text);
    expect(rendered).not.toContain("z".repeat(200));
    expect(rendered).toContain("withheld 1 frontier node that did not fit");
    expect(rendered).toContain(`expand: lcm.summary:${frontier[0]!.nodeId}`);
  });

  it("never emits a partial summary address at the overflow boundary", () => {
    for (let size = 10_800; size <= 10_900; size += 1) {
      const frontier = Array.from({ length: 3 }, (_, index) => ({ ...bigNode(index, size), sources: [], text: "z".repeat(size) }));
      const rendered = renderAddressedFrontier(frontier as unknown as Parameters<typeof renderAddressedFrontier>[0]);
      const known = new Set(frontier.map((node) => `lcm.summary:${node.nodeId}`));
      expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
      expect(rendered.endsWith(LCM_RECOVERY_POINTER)).toBe(true);
      for (const address of [...rendered.matchAll(/lcm\.summary:[^\s,]+/g)].map((match) => match[0])) {
        expect(known).toContain(address);
      }
    }
  });

  it("addresses a condensed node through its children", () => {
    const frontier = [{ nodeId: "top", kind: "condensed", sources: [], children: ["a", "b"], text: "rolled up" }] as unknown as Parameters<typeof renderAddressedFrontier>[0];
    const rendered = renderAddressedFrontier(frontier);
    expect(rendered).toContain("lcm.summary:top");
    expect(rendered).toContain("children: lcm.summary:a, lcm.summary:b");
  });

  it("persists without spending model calls below the maintenance occupancy", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "source")];
    const context = makeContext(root, entries);
    (context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 1_000, contextWindow: 100_000, percent: 20 });
    const runtime = openRuntime(context, { rootDir: root, softThresholdRatio: 0.55 });
    let scheduled = 0;
    (runtime as unknown as { scheduleMaintenance: () => void }).scheduleMaintenance = () => { scheduled += 1; };
    await runtime.syncAndSchedule();
    expect(scheduled).toBe(0);
    expect(runtime.raw("session-1")).toHaveLength(1);
    await runtime.shutdown();
  });

  it("schedules maintenance once the occupancy reaches the soft threshold", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "source")];
    const context = makeContext(root, entries);
    (context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
    const runtime = openRuntime(context, { rootDir: root, softThresholdRatio: 0.55 });
    let scheduled = 0;
    (runtime as unknown as { scheduleMaintenance: () => void }).scheduleMaintenance = () => { scheduled += 1; };
    await runtime.syncAndSchedule();
    expect(scheduled).toBe(1);
    expect(runtime.raw("session-1")).toHaveLength(1);
    await runtime.shutdown();
  });

  it("runs maintenance when the occupancy cannot be read", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "source")];
    const missing = makeContext(root, entries);
    const nulled = makeContext(root, entries);
    (nulled as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: null, contextWindow: null, percent: null });
    const throwing = makeContext(root, entries);
    (throwing as unknown as { getContextUsage: () => unknown }).getContextUsage = () => { throw new Error("no reading"); };
    for (const context of [missing, nulled, throwing]) {
      const runtime = openRuntime(context, { rootDir: root, softThresholdRatio: 0.55 });
      expect(runtime.maintenanceOccupancyReached()).toBe(true);
      await runtime.shutdown();
    }
  });

  it("reclaims a dead lease below the maintenance occupancy", async () => {
    const root = makeRoot();
    const context = makeContext(root, [makeEntry("e1", "source")]);
    (context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 1_000, contextWindow: 100_000, percent: 20 });
    const runtime = openRuntime(context, { rootDir: root, softThresholdRatio: 0.55 });
    await runtime.readback();
    const stranded = runtime.maintenance.createLeaf([historyEntry(runtime, 0)]);
    if (!stranded) throw new Error("expected a stranded node");
    const job = runtime.maintenance.jobForNode(stranded.nodeId);
    if (!job) throw new Error("expected a stranded job");
    const claimed = runtime.maintenance.claim(job.jobId);
    runtime.ledger.transaction((db) => db.prepare("UPDATE maintenance_jobs SET payload=? WHERE job_id=? AND project_key=?")
      .run(JSON.stringify({ ...claimed, leaseUntil: Date.now() - 18 * 60 * 60 * 1_000 }), claimed.jobId, runtime.projectKey));
    expect(runtime.maintenance.jobForNode(stranded.nodeId)?.state).toBe("running");

    let scheduled = 0;
    (runtime as unknown as { scheduleMaintenance: () => void }).scheduleMaintenance = () => { scheduled += 1; };
    await runtime.syncAndSchedule();

    expect(runtime.maintenanceOccupancyReached()).toBe(false);
    expect(runtime.maintenance.jobForNode(stranded.nodeId)?.state).toBe("pending");
    expect(scheduled).toBe(0);
    await runtime.shutdown();
  });

  it("schedules a pass on branch backlog the occupancy floor never reaches", async () => {
    const chain = (count: number): SessionEntry[] => Array.from({ length: count }, (_, index) =>
      makeEntry("e" + index, "backlog source " + index, index === 0 ? null : "e" + (index - 1)));
    const below = (entries: SessionEntry[]): LcmRuntime => {
      const root = makeRoot();
      const context = makeContext(root, entries);
      (context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 1_000, contextWindow: 100_000, percent: 20 });
      return openRuntime(context, { rootDir: root, softThresholdRatio: 0.55, maxLeafEntries: 4 });
    };

    const trivial = below(chain(2));
    let trivialPasses = 0;
    (trivial as unknown as { scheduleMaintenance: () => void }).scheduleMaintenance = () => { trivialPasses += 1; };
    await trivial.syncAndSchedule();
    expect(trivial.maintenanceOccupancyReached()).toBe(false);
    expect(trivial.maintenanceTrigger()).toBeUndefined();
    expect(trivialPasses).toBe(0);
    await trivial.shutdown();

    const busy = below(chain(6));
    let busyPasses = 0;
    (busy as unknown as { scheduleMaintenance: () => void }).scheduleMaintenance = () => { busyPasses += 1; };
    await busy.syncAndSchedule();
    expect(busy.maintenanceOccupancyReached()).toBe(false);
    expect(busy.maintenanceTrigger()).toBe("backlog");
    expect(busyPasses).toBe(1);
    await busy.shutdown();
  });

  it("schedules no pass at all once the model budget is exhausted", async () => {
    const root = makeRoot();
    const entries = Array.from({ length: 8 }, (_, index) =>
      makeEntry("e" + index, "budgeted source " + index, index === 0 ? null : "e" + (index - 1)));
    const context = makeContext(root, entries);
    (context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
    const runtime = openRuntime(context, { rootDir: root, softThresholdRatio: 0.55, maxLeafEntries: 4, maxDailyModelCalls: 2 });
    await runtime.readback();
    expect(runtime.maintenanceTrigger()).toBe("occupancy");

    runtime.ledger.transaction((db) => db.prepare("INSERT INTO maintenance_usage(project_key,day,session_id,calls,input_tokens,output_tokens,cost,wall_ms) VALUES(?,?,?,?,?,?,?,?)")
      .run(runtime.projectKey, new Date().toISOString().slice(0, 10), "session-1", 2, 10, 5, 0, 100));

    expect(runtime.maintenanceTrigger()).toBeUndefined();
    await runtime.syncAndSchedule();
    await settle(runtime);
    expect(runtime.maintenance.listNodes(100)).toHaveLength(0);
    expect(runtime.maintenance.listJobs()).toHaveLength(0);
    await runtime.shutdown();
  });

  it("holds a ready frontier at compaction time below the occupancy floor", async () => {
    const root = makeRoot();
    const entries = Array.from({ length: 12 }, (_, index) =>
      makeEntry("e" + index, "compaction source " + index, index === 0 ? null : "e" + (index - 1)));
    const context = makeContext(root, entries);
    (context as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 20_000, contextWindow: 100_000, percent: 20 });
    const runtime = openRuntime(context, { rootDir: root, softThresholdRatio: 0.55, maxLeafEntries: 4, maxMaintenancePasses: 4 });

    await runtime.syncAndSchedule();
    await settle(runtime);

    expect(runtime.maintenanceOccupancyReached()).toBe(false);
    const compacted = runtime.compact({ branchEntries: entries, sessionId: "session-1", firstKeptEntryId: "e8", tokensBefore: 100 });
    expect(compacted.source).toBe("ready-frontier");
    await runtime.shutdown();
  });

  it("covers the live branch when completed history outgrows the job page", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "live source one"), makeEntry("e2", "live source two", "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();

    for (let index = 0; index < 105; index += 1) {
      const stored = historyEntry(runtime, index);
      const node = runtime.maintenance.createLeaf([stored]);
      if (!node) throw new Error("missing history node");
      const job = runtime.maintenance.jobForNode(node.nodeId);
      if (!job) throw new Error("missing history job");
      runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(job.jobId), `history summary ${index}`);
    }
    runtime.ledger.transaction((db) => db.prepare("UPDATE maintenance_jobs SET created_at=rowid WHERE project_key=? AND status=?").run(runtime.projectKey, "completed"));

    const page = runtime.maintenance.listJobs();
    expect(page).toHaveLength(100);
    expect(page.every((job) => job.state === "completed")).toBe(true);

    await runtime.maintain();
    await settle(runtime);

    const coverage = runtime.coverage();
    expect(coverage.active).toBe(2);
    expect(coverage.covered).toBe(2);
    expect(runtime.report().pendingJobs).toBe(0);
    await runtime.shutdown();
  });

  it("records a maintenance failure that never reached its claim", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "live source one"), makeEntry("e2", "live source two", "e1")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();
    const rows = runtime.raw("session-1");
    const orphan = runtime.maintenance.createLeaf([rows[0]!]);
    if (!orphan) throw new Error("missing orphan node");
    expect(runtime.maintenance.jobForNode(orphan.nodeId)?.attempts).toBe(0);
    runtime.ledger.transaction((db) => db.prepare("DELETE FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND revision=?")
      .run(runtime.projectKey, rows[0]!.sessionId, rows[0]!.entryId, rows[0]!.revision));

    runtime.scheduleMaintenance();
    await settle(runtime);

    const job = runtime.maintenance.jobForNode(orphan.nodeId);
    expect(job?.attempts).toBe(1);
    expect(job?.error).toContain("stale source");
    expect(runtime.status).toBe("degraded");
    await runtime.shutdown();
  });

  it("leaves a session whose file is not written yet healthy", async () => {
    const root = makeRoot();
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], path.join(root, "unwritten.jsonl")), { rootDir: root });
    await runtime.reconcileSelectedSession();

    expect(runtime.reconciliation?.errors).toBe(0);
    expect(runtime.reconciliation?.absent).toBe(1);
    expect(runtime.status).toBe("healthy");
    expect(runtime.report().degraded).toBeUndefined();
    await runtime.shutdown();
  });

  it("clears a reconciliation error once a later pass reads the session file", async () => {
    const root = makeRoot();
    const selected = writeSession(root, "late.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();

    expect(runtime.reconciliation?.errors).toBe(1);
    expect(runtime.report().degraded).toContain("reported 1 error(s)");

    unreadable.mockRestore();
    await runtime.maintain();

    expect(runtime.reconciliation?.errors).toBe(0);
    expect(runtime.report().degraded ?? "").not.toContain("reconciliation");
    await runtime.shutdown();
  });

  it("keeps reporting a session file that never becomes readable", async () => {
    const root = makeRoot();
    const selected = writeSession(root, "unreadable.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();

    for (let turn = 0; turn < 5; turn += 1) await runtime.maintain();
    unreadable.mockRestore();

    expect(runtime.reconciliation?.errors).toBe(1);
    expect(runtime.report().degraded).toContain("reported 1 error(s)");
    expect(runtime.report().state).toBe("degraded");
    expect(runtime.report().ledgerState).toBe("healthy");
    await runtime.shutdown();
  });

  it("keeps a dropped entry surfaced across later passes", async () => {
    const root = makeRoot();
    const selected = path.join(root, "dropped.jsonl");
    const oversized = { type: "message", id: "huge", parentId: null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: "x".repeat(8 * 1_024 * 1_024) } };
    fs.writeFileSync(selected, `${JSON.stringify({ type: "session", id: "session-1", cwd: root, timestamp: "2026-09-01T00:00:00.000Z" })}\n${JSON.stringify(makeEntry("e1", "source"))}\n${JSON.stringify(oversized)}\n`);
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    await runtime.reconcileSelectedSession();

    expect(runtime.reconciliation?.drops.entries).toBe(1);
    expect(runtime.report().degraded).toContain("1 line skipped as oversized");

    await runtime.maintain();

    expect(runtime.report().degraded).toContain("1 line skipped as oversized");
    expect(runtime.report().state).toBe("degraded");
    expect(runtime.report().ledgerState).toBe("healthy");
    await runtime.shutdown();
  });

  it("keeps a reconciliation error visible after the next readback", async () => {
    const root = makeRoot();
    const selected = writeSession(root, "still-broken.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();

    expect(runtime.reconciliation?.errors).toBe(1);
    expect(runtime.status).toBe("degraded");
    expect(runtime.report().degraded?.match(/reported 1 error/g)).toHaveLength(1);

    await runtime.readback();
    unreadable.mockRestore();

    expect(runtime.reconciliation?.errors).toBe(1);
    expect(runtime.status).toBe("degraded");
    expect(runtime.report().degraded).toContain("reported 1 error(s)");
    await runtime.shutdown();
  });

  it("repairs a readable session file on request and records the outcome", async () => {
    const root = makeRoot();
    const selected = writeSession(root, "repairable.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();

    expect(runtime.status).toBe("degraded");

    unreadable.mockRestore();
    const outcome = await runtime.repair("reconcile");

    expect(outcome.changed).toBe(true);
    expect(runtime.status).toBe("healthy");
    expect(runtime.diagnostics().repairs[0]?.id).toBe("reconcile");
    await runtime.shutdown();
  });

  it("appends only the branch entries it has not stored yet", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "first"), makeEntry("e2", "second")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    await runtime.readback();

    const append = vi.spyOn(runtime.ledger, "appendRaw");
    await runtime.readback();

    expect(append).not.toHaveBeenCalled();

    entries.push(makeEntry("e3", "third"));
    await runtime.readback();

    expect(append).toHaveBeenCalledTimes(1);
    expect(runtime.ledger.readRaw(runtime.projectKey)).toHaveLength(3);
    expect(runtime.coverage().active).toBe(3);
    append.mockRestore();
    await runtime.shutdown();
  });

  it("re-reads the whole branch when the session changes", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "first")];
    let sessionId = "session-1";
    const context = makeContext(root, entries);
    context.sessionManager.getSessionId = () => sessionId;
    const runtime = openRuntime(context, { rootDir: root });
    await runtime.readback();

    sessionId = "session-2";
    const append = vi.spyOn(runtime.ledger, "appendRaw");
    await runtime.readback();

    expect(append).toHaveBeenCalledTimes(1);
    expect(runtime.ledger.readRaw(runtime.projectKey, "session-2")).toHaveLength(1);
    append.mockRestore();
    await runtime.shutdown();
  });

  it("budgets automatic repair per fault and parks it after the last attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const root = makeRoot();
    const selected = writeSession(root, "budgeted.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();

    expect(runtime.status).toBe("degraded");
    expect((await runtime.autoRepair())?.id).toBe("reconcile");
    expect(runtime.diagnostics().autoRepairs[0]).toMatchObject({ fault: "reconcile", attempts: 1 });
    expect(await runtime.autoRepair()).toBeUndefined();

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      vi.setSystemTime(Date.now() + 20 * 60 * 1_000);
      expect((await runtime.autoRepair())?.id).toBe("reconcile");
    }

    expect(runtime.diagnostics().autoRepairs[0]?.attempts).toBe(5);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000);

    expect(await runtime.autoRepair()).toBeUndefined();
    expect(runtime.status).toBe("degraded");
    unreadable.mockRestore();
    vi.useRealTimers();
    await runtime.shutdown();
  });

  it("recovers the runtime once the fault it tracked is gone", async () => {
    const root = makeRoot();
    const selected = writeSession(root, "recovering.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();
    await runtime.autoRepair();

    expect(runtime.diagnostics().autoRepairs).toHaveLength(1);

    unreadable.mockRestore();
    await runtime.reconcileSelectedSession();

    expect(runtime.status).toBe("healthy");
    await runtime.shutdown();
  });

  it("stops reporting an absent session file once the host writes it", async () => {
    const root = makeRoot();
    const selected = path.join(root, "deferred.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    await runtime.reconcileSelectedSession();

    expect(runtime.reconciliation?.absent).toBe(1);

    writeSession(root, "deferred.jsonl");
    await runtime.syncAndSchedule();

    expect(runtime.reconciliation?.absent).toBe(0);
    expect(runtime.diagnostics().sessionFilePresent).toBe(true);
    await runtime.shutdown();
  });

  it("stores a new revision for a branch entry amended in place", async () => {
    const root = makeRoot();
    const entry = makeEntry("e1", "first") as SessionEntry & { message: { content: Array<{ type: string; text: string }> } };
    const runtime = openRuntime(makeContext(root, [entry]), { rootDir: root });
    await runtime.readback();

    entry.message.content[0]!.text = "amended";
    await runtime.readback();

    const stored = runtime.ledger.readRaw(runtime.projectKey, "session-1");
    expect(stored.map((row) => row.revision)).toEqual([1, 2]);
    expect(runtime.coverage()).toEqual({ active: 1, covered: 0 });
    expect(runtime.frontier("session-1")).toHaveLength(0);
    await runtime.shutdown();
  });

  it("holds a repair inside its backoff and releases it when the delay passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const root = makeRoot();
    const selected = writeSession(root, "backoff.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();
    await runtime.autoRepair();

    vi.setSystemTime(Date.now() + 29_000);
    expect(await runtime.autoRepair()).toBeUndefined();
    vi.setSystemTime(Date.now() + 2_000);
    expect((await runtime.autoRepair())?.id).toBe("reconcile");

    vi.setSystemTime(Date.now() + 59_000);
    expect(await runtime.autoRepair()).toBeUndefined();
    vi.setSystemTime(Date.now() + 2_000);
    expect((await runtime.autoRepair())?.id).toBe("reconcile");

    expect(runtime.diagnostics().autoRepairs[0]?.attempts).toBe(3);
    unreadable.mockRestore();
    vi.useRealTimers();
    await runtime.shutdown();
  });

  it("keeps a repair budget alive while its fault keeps coming back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    const root = makeRoot();
    const selected = writeSession(root, "flapping.jsonl");
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")], selected), { rootDir: root });
    const unreadable = failReads();
    await runtime.reconcileSelectedSession();
    await runtime.autoRepair();
    unreadable.mockRestore();
    await runtime.reconcileSelectedSession();

    vi.setSystemTime(Date.now() + 60_000);
    await runtime.autoRepair();

    expect(runtime.diagnostics().autoRepairs[0]).toMatchObject({ fault: "reconcile", attempts: 1 });

    vi.setSystemTime(Date.now() + 31 * 60_000);
    await runtime.autoRepair();

    expect(runtime.diagnostics().autoRepairs).toHaveLength(0);
    vi.useRealTimers();
    await runtime.shutdown();
  });

  it("lists failed maintenance jobs ahead of the page limit", async () => {
    const root = makeRoot();
    const runtime = openRuntime(makeContext(root, [makeEntry("e1", "source")]), { rootDir: root });
    await runtime.readback();
    for (let index = 0; index < 3; index += 1) {
      const stored = historyEntry(runtime, index);
      const node = runtime.maintenance.createLeaf([stored]);
      if (!node) throw new Error("missing node");
      const job = runtime.maintenance.jobForNode(node.nodeId);
      if (!job) throw new Error("missing job");
      if (index === 2) {
        let failing: LcmJob | undefined = job;
        for (let attempt = 0; attempt < 3 && failing; attempt += 1) failing = runtime.maintenance.recordFailure(failing, "boom");
      } else {
        runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(job.jobId), `summary ${index}`);
      }
    }

    const page = runtime.jobs(1);

    expect(page).toHaveLength(1);
    expect(page[0]?.state).toBe("failed");
    await runtime.shutdown();
  });

  it("builds a leaf across rows an earlier version labelled with different leaf ids", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "one"), makeEntry("e2", "two", "e1"), makeEntry("e3", "three", "e2"), makeEntry("e4", "four", "e3")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root, maxLeafEntries: 3 });
    runtime.ledger.transaction(() => {
      for (const [index, entry] of entries.entries()) {
        runtime.ledger.appendRaw({
          projectKey: runtime.projectKey,
          sessionId: "session-1",
          entryId: entry.id,
          role: "user",
          content: "seeded",
          payloadJson: canonicalLcmPayload(entry),
          branch: index < 2 ? "leaf-A" : "leaf-B",
        });
      }
    });
    await runtime.readback();
    const stored = runtime.ledger.readRaw(runtime.projectKey, "session-1");

    expect(new Set(stored.map((row) => row.branch)).size).toBe(2);

    const picked = runtime.maintenance.selectLeaf(stored, new Set(stored.map((row) => `session-1:${row.entryId}:${row.revision}`)));

    expect(picked.map((row) => row.entryId)).toEqual(["e1", "e2", "e3"]);
    expect(runtime.maintenance.createLeaf(picked)?.sources).toHaveLength(3);
    await runtime.shutdown();
  });

  it("serves one summary after a rewind remints a prefix another node already covers", async () => {
    const root = makeRoot();
    const entries = [makeEntry("e1", "one"), makeEntry("e2", "two", "e1"), makeEntry("e3", "three", "e2")];
    const runtime = openRuntime(makeContext(root, entries), { rootDir: root });
    const summarize = async (): Promise<void> => {
      const live = runtime.ledger
        .readRaw(runtime.projectKey, "session-1")
        .filter((row) => entries.some((entry) => entry.id === row.entryId));
      const active = new Set(live.map((row) => `session-1:${row.entryId}:${row.revision}`));
      const picked = runtime.maintenance.selectLeaf(live, active);
      if (picked.length === 0) return;
      const node = runtime.maintenance.createLeaf(picked);
      if (!node) return;
      const job = runtime.maintenance.jobForNode(node.nodeId);
      if (!job) throw new Error("missing job");
      runtime.maintenance.completeEmergency(runtime.maintenance.claimEmergency(job.jobId), `summary of ${picked.length}`);
    };
    await runtime.readback();
    await summarize();

    expect(runtime.frontier("session-1")).toHaveLength(1);

    entries.splice(2);
    await runtime.readback();
    await summarize();
    entries.push(makeEntry("e3", "three", "e2"));
    await runtime.readback();

    const frontier = runtime.frontier("session-1");

    expect(frontier).toHaveLength(1);
    expect(frontier[0]?.sources).toHaveLength(3);
    expect(runtime.coverage()).toEqual({ active: 3, covered: 3 });
    await runtime.shutdown();
  });
});
