import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { EventLoopSlice } from "../../src/core/event-loop-slice.js";
import { LcmRuntime } from "../../src/compaction/lcm-runtime.js";
import { reconcileSession } from "../../src/storage/lcm-migration.js";
import { sqliteDriver } from "../../src/storage/sqlite.js";
import type { LcmLedger } from "../../src/storage/lcm-ledger.js";
import { closeAfterTest, openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";

afterEach(releaseTemp);

const makeEntry = (index: number): SessionEntry => ({
  type: "message",
  id: `e${index}`,
  parentId: index === 0 ? null : `e${index - 1}`,
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, index % 60, index % 1_000)).toISOString(),
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `source ${index} ${"x".repeat(256)}` }] },
} as SessionEntry);

const writeSession = (root: string, cwd: string, count: number): string => {
  const file = path.join(root, "session.jsonl");
  const lines = [JSON.stringify({ type: "session", id: "session-1", cwd, timestamp: "2026-09-01T00:00:00.000Z" })];
  for (let index = 0; index < count; index += 1) lines.push(JSON.stringify(makeEntry(index)));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

const rawRows = (ledger: LcmLedger) => ledger.db
  .prepare("SELECT session_id,entry_id,revision,role,content_hash,payload_json,parent_entry_id,created_at FROM raw_entries ORDER BY entry_id,revision")
  .all();

const firedBefore = <T>(work: () => Promise<T>): Promise<{ value: T; fired: boolean }> => {
  let fired = false;
  setImmediate(() => { fired = true; });
  return work().then((value) => ({ value, fired }));
};

const makeContext = (cwd: string, entries: SessionEntry[], agent?: { kind: "main" | "sub"; depth: number }, sessionFile?: string): ExtensionContext => ({
  cwd,
  model: undefined,
  modelRegistry: {} as ExtensionContext["modelRegistry"],
  ...(agent ? { agent: { ...agent, id: agent.kind === "main" ? "Main" : "0-Task", name: agent.kind === "main" ? "main" : "task" } } : {}),
  sessionManager: {
    getRecordedCwd: () => cwd,
    getSessionFile: () => sessionFile,
    getSessionId: () => "session-1",
    getLeafId: () => "branch-a",
    getBranch: () => entries,
  },
} as unknown as ExtensionContext);

const settle = (runtime: LcmRuntime): Promise<void> => (runtime as unknown as { maintenancePending: Promise<void> }).maintenancePending;

describe("LCM work yields to the event loop", () => {
  it("imports a session in slices and stores exactly what one synchronous run stores", async () => {
    const root = tempRoot("lcm-yield-migration-");
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const file = writeSession(root, cwd, 600);
    const options = { agentDir: root, files: [file] as [string], liveCwd: cwd, projectCwd: cwd, apply: true };

    const whole = openLedger({ dbPath: path.join(root, "whole.sqlite"), project: { liveCwd: cwd } });
    const wholeRun = await firedBefore(() => reconcileSession({ ...options, ledger: whole, slice: new EventLoopSlice(Number.POSITIVE_INFINITY) }));

    const sliced = openLedger({ dbPath: path.join(root, "sliced.sqlite"), project: { liveCwd: cwd } });
    const slice = new EventLoopSlice(0);
    const slicedRun = await firedBefore(() => reconcileSession({ ...options, ledger: sliced, slice }));

    expect(slicedRun.fired).toBe(true);
    expect(slice.yields).toBeGreaterThan(600);
    expect(slicedRun.value.counts).toEqual(wholeRun.value.counts);
    expect(slicedRun.value.counts.imported).toBe(600);
    expect(rawRows(sliced)).toEqual(rawRows(whole));
  });

  it("runs startup scans off the event loop and still re-syncs a drifted full-text index", async () => {
    const root = tempRoot("lcm-yield-startup-");
    const dbPath = path.join(root, "ledger.sqlite");
    const seeded = openLedger({ dbPath, project: { liveCwd: root } });
    for (const id of ["a", "b", "c"]) {
      seeded.appendRaw({ projectKey: seeded.project.key, sessionId: "s1", entryId: id, role: "user", content: `drift needle ${id}`, payloadJson: JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: `drift needle ${id}` } }) });
    }
    seeded.close();
    if (!seeded.ftsAvailable) return;
    const raw = new (sqliteDriver())(dbPath);
    raw.exec("DELETE FROM raw_entries_fts WHERE rowid=(SELECT min(rowid) FROM raw_entries_fts)");
    raw.close();

    const ledger = openLedger({ dbPath, project: { liveCwd: root } });
    const run = await firedBefore(() => ledger.runStartupChecks());

    expect(run.fired).toBe(true);
    expect(ledger.startupChecksComplete).toBe(true);
    expect(ledger.migrations.find((report) => report.name === "raw-entries-fts")).toMatchObject({ applied: true, counts: { indexed: 3 } });
    expect(ledger.searchRaw(undefined, { query: "needle", mode: "literal", offset: 0, limit: 5 }).rows).toHaveLength(3);
  });

  it("slices maintenance passes and builds the same summary nodes as an unsliced pass", async () => {
    const cwd = tempRoot("lcm-yield-maintenance-");
    const entries = Array.from({ length: 96 }, (_, index) => makeEntry(index));
    const build = async (sliceMs: number) => {
      const rootDir = tempRoot("lcm-yield-maintenance-ledger-");
      const runtime = closeAfterTest(new LcmRuntime(makeContext(cwd, entries), { rootDir, sliceMs, maxLeafEntries: 4, maxMaintenancePasses: 12, modelSummaries: false }), (value) => value.shutdown());
      await runtime.readback();
      const run = await firedBefore(async () => {
        runtime.scheduleMaintenance();
        await settle(runtime);
      });
      const nodes = runtime.maintenance.listNodes(10_000)
        .map((node) => ({ kind: node.kind, depth: node.depth, state: node.state, modelHash: node.modelHash, text: node.text, sources: node.sources.map((source) => source.entryId).join(",") }))
        .sort((left, right) => left.sources.localeCompare(right.sources) || left.depth - right.depth);
      return { fired: run.fired, nodes };
    };

    const whole = await build(Number.POSITIVE_INFINITY);
    const sliced = await build(0);

    expect(whole.nodes.length).toBeGreaterThan(4);
    expect(whole.fired).toBe(false);
    expect(sliced.fired).toBe(true);
    expect(sliced.nodes).toEqual(whole.nodes);
  });

  it("leaves ledger migration and maintenance to the parent session in subagents", async () => {
    const root = tempRoot("lcm-yield-owner-");
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const file = writeSession(root, cwd, 4);
    const entries = Array.from({ length: 4 }, (_, index) => makeEntry(index));
    const sub = closeAfterTest(new LcmRuntime(makeContext(cwd, entries, { kind: "sub", depth: 1 }, file), { rootDir: path.join(root, "ledgers"), maxLeafEntries: 2 }), (value) => value.shutdown());

    expect(sub.owner).toBe(false);
    await sub.open();
    await sub.reconcileSelectedSession();
    await sub.syncAndSchedule();
    await settle(sub);
    expect(sub.ledger.startupChecksComplete).toBe(false);
    expect(sub.ready).toBe(false);
    expect(sub.raw()).toHaveLength(0);
    expect(sub.maintenance.listNodes(100)).toHaveLength(0);
    expect(sub.memoryContext().ledger.projectKey).toBe(sub.projectKey);

    const main = closeAfterTest(new LcmRuntime(makeContext(cwd, entries, { kind: "main", depth: 0 }, file), { rootDir: path.join(root, "ledgers"), maxLeafEntries: 2 }), (value) => value.shutdown());
    expect(main.owner).toBe(true);
    await main.open();
    expect(main.ready).toBe(false);
    await main.reconcileSelectedSession();
    expect(main.ready).toBe(true);
    expect(main.raw("session-1")).toHaveLength(4);
  });
});
