import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { defaultLedgerPath, LcmLedger } from "../src/storage/lcm-ledger.ts";
import { reconcileSession } from "../src/storage/lcm-migration.ts";
import { LcmRuntime } from "../src/compaction/lcm-runtime.ts";
import { registerCompactionHook } from "../dist/compaction/hook.js";
import { LcmMemoryAdapter } from "../src/memory/lcm-adapter.ts";

const SESSIONS = 10;
const ENTRIES_PER_SESSION = 1_000;
const CONTENT_BYTES = 1_024;
const CYCLES = 20;
const CYCLE_BRANCH_ENTRIES = 200;
const CYCLE_KEPT_ENTRIES = 50;
const NEEDLE = "zircon-needle";
const NEEDLE_EVERY = 100;
const HOOK_P95_BUDGET_MS = 250;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-benchmark-"));
const projectCwd = path.join(root, "project");
const agentDir = path.join(root, "agent");
fs.mkdirSync(projectCwd, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });

const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(32);
const entryText = (session, index) => {
  const head = index % NEEDLE_EVERY === 0 ? NEEDLE + " " : "";
  return (head + "session " + session + " entry " + index + " " + filler).slice(0, CONTENT_BYTES);
};
const makeEntry = (session, index) => ({
  type: "message",
  id: "s" + session + "-e" + index,
  parentId: index === 0 ? null : "s" + session + "-e" + (index - 1),
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, index % 60)).toISOString(),
  message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: entryText(session, index) }] },
});
const sessionEntries = Array.from({ length: SESSIONS }, (_, session) =>
  Array.from({ length: ENTRIES_PER_SESSION }, (_, index) => makeEntry(session, index)));

let modelTouches = 0;
const modelTrap = new Proxy({}, {
  get(_target, property) {
    if (property !== "then" && typeof property !== "symbol") modelTouches += 1;
    return undefined;
  },
});

const state = { sessionId: "session-0", branch: "branch-0", entries: sessionEntries[0] };
const context = {
  cwd: projectCwd,
  hasUI: false,
  model: undefined,
  modelRegistry: modelTrap,
  sessionManager: {
    getRecordedCwd: () => projectCwd,
    getSessionFile: () => undefined,
    getSessionId: () => state.sessionId,
    getLeafId: () => state.branch,
    getBranch: () => state.entries,
  },
};

const percentile = (values, fraction) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
};
const round = (value) => Math.round(value * 1000) / 1000;
const fileSize = (target) => {
  try { return fs.statSync(target).size; } catch { return 0; }
};

const failures = [];
const check = (condition, label, detail) => {
  if (!condition) failures.push(detail === undefined ? label : label + ": " + detail);
};

const stopPath = path.join(root, "contender.stop");
const contenderReportPath = path.join(root, "contender.json");
const dbPath = defaultLedgerPath(root, "");
const runtime = new LcmRuntime(context, { rootDir: root });
const ledgerPath = defaultLedgerPath(root, runtime.projectKey);
const contender = spawn(process.execPath, [
  path.join(scriptDir, "benchmark-lcm-contender.mjs"),
  ledgerPath,
  path.join(root, "contender-project"),
  contenderReportPath,
  stopPath,
], { stdio: ["ignore", "inherit", "inherit"] });

const ingestDurations = [];
const ingestStart = performance.now();
for (let session = 0; session < SESSIONS; session += 1) {
  state.sessionId = "session-" + session;
  state.branch = "branch-" + session;
  state.entries = sessionEntries[session];
  const started = performance.now();
  await runtime.readback();
  ingestDurations.push(performance.now() - started);
}
const ingestMs = performance.now() - ingestStart;

const ingestedRows = sessionEntries.reduce((total, entries, session) =>
  total + runtime.ledger.readRaw(runtime.projectKey, "session-" + session).length, 0);
check(ingestedRows === SESSIONS * ENTRIES_PER_SESSION, "lossless ingest",
  ingestedRows + " rows vs " + SESSIONS * ENTRIES_PER_SESSION);

const duplicateKeys = runtime.ledger.readOnly((db) => db
  .prepare("SELECT count(*) n FROM (SELECT session_id, entry_id, revision, count(*) c FROM raw_entries WHERE project_key=? GROUP BY session_id, entry_id, revision HAVING c > 1)")
  .get(runtime.projectKey).n);
check(duplicateKeys === 0, "no duplicate raw rows", String(duplicateKeys));

const handlers = new Map();
registerCompactionHook({ on: (event, handler) => { handlers.set(event, handler); } }, {
  getEngine: () => "lcm",
  lcm: { compact: (input) => runtime.compact(input) },
});
const onBeforeCompact = handlers.get("session_before_compact");
if (typeof onBeforeCompact !== "function") throw new Error("compaction hook did not register session_before_compact");

const modelTouchesBeforeCycles = modelTouches;
const hookDurations = [];
const sourceCounts = { "ready-frontier": 0, emergency: 0 };
for (let cycle = 0; cycle < CYCLES; cycle += 1) {
  const session = cycle % SESSIONS;
  state.sessionId = "session-" + session;
  state.branch = "branch-" + session;
  const offset = Math.floor(cycle / SESSIONS) * CYCLE_BRANCH_ENTRIES;
  const branchEntries = sessionEntries[session].slice(offset, offset + CYCLE_BRANCH_ENTRIES);
  state.entries = branchEntries;
  const firstKept = branchEntries[branchEntries.length - CYCLE_KEPT_ENTRIES];
  const event = {
    branchEntries,
    customInstructions: undefined,
    preparation: { firstKeptEntryId: firstKept.id, tokensBefore: 100_000 },
  };
  const started = performance.now();
  const result = onBeforeCompact(event, context);
  hookDurations.push(performance.now() - started);
  check(typeof result?.compaction?.summary === "string" && result.compaction.summary.length > 0,
    "cycle " + cycle + " produced a summary");
  check(result?.compaction?.firstKeptEntryId === firstKept.id, "cycle " + cycle + " kept boundary");
  check(result?.compaction?.details?.compactor === "lcm", "cycle " + cycle + " compactor tag");
  const source = result?.compaction?.details?.source;
  if (source in sourceCounts) sourceCounts[source] += 1;
}
const repeatDurations = [];
const repeatSources = { "ready-frontier": 0, emergency: 0 };
for (let cycle = 0; cycle < CYCLES; cycle += 1) {
  const session = cycle % SESSIONS;
  state.sessionId = "session-" + session;
  state.branch = "branch-" + session;
  const offset = Math.floor(cycle / SESSIONS) * CYCLE_BRANCH_ENTRIES;
  const branchEntries = sessionEntries[session].slice(offset, offset + CYCLE_BRANCH_ENTRIES);
  state.entries = branchEntries;
  const firstKept = branchEntries[branchEntries.length - CYCLE_KEPT_ENTRIES];
  const started = performance.now();
  const result = onBeforeCompact({
    branchEntries,
    customInstructions: undefined,
    preparation: { firstKeptEntryId: firstKept.id, tokensBefore: 100_000 },
  }, context);
  repeatDurations.push(performance.now() - started);
  const source = result?.compaction?.details?.source;
  if (source in repeatSources) repeatSources[source] += 1;
}
check(repeatSources["ready-frontier"] === CYCLES, "repeat cycles reuse the ready frontier",
  repeatSources["ready-frontier"] + " of " + CYCLES);

const hookModelCalls = modelTouches - modelTouchesBeforeCycles;
check(hookModelCalls === 0, "zero hook model calls", String(hookModelCalls));
const hookP95 = percentile(hookDurations, 0.95);
check(hookP95 < HOOK_P95_BUDGET_MS, "hook p95 under budget", round(hookP95) + "ms");

const nodes = runtime.maintenance.listNodes(1_000_000);
const nodeIds = new Set(nodes.map((node) => node.nodeId));
check(nodeIds.size === nodes.length, "unique node identities", nodes.length - nodeIds.size + " duplicates");
const committedSources = new Set(runtime.ledger.readRaw(runtime.projectKey)
  .map((entry) => entry.sessionId + ":" + entry.entryId + ":" + entry.revision));
let danglingChildren = 0;
let uncommittedSources = 0;
for (const node of nodes) {
  for (const child of node.children) if (!nodeIds.has(child)) danglingChildren += 1;
  for (const source of node.sources) {
    if (!committedSources.has(source.sessionId + ":" + source.entryId + ":" + source.revision)) uncommittedSources += 1;
  }
}
check(danglingChildren === 0, "no frontier child references uncommitted nodes", String(danglingChildren));
check(uncommittedSources === 0, "no node references uncommitted sources", String(uncommittedSources));
const backlog = runtime.maintenance.listJobs(1_000_000).length;
check(backlog <= nodes.length, "bounded maintenance backlog", backlog + " jobs for " + nodes.length + " nodes");

const adapter = new LcmMemoryAdapter(runtime.memoryContext());
const recallStart = performance.now();
const recalled = adapter.recall({ query: NEEDLE });
const recallMs = performance.now() - recallStart;
const rawHits = recalled.hits.filter((hit) => hit.kind === "lcm.raw");
const precise = rawHits.filter((hit) => JSON.stringify(hit).includes(NEEDLE)).length;
const recallPrecision = rawHits.length === 0 ? 0 : precise / rawHits.length;
check(rawHits.length > 0, "recall returns raw hits");
check(recallPrecision === 1, "recall precision", String(round(recallPrecision)));
const expandStart = performance.now();
const expanded = rawHits.length > 0 ? adapter.expand({ session: rawHits[0].follow.args.session }) : { entries: [] };
const expandMs = performance.now() - expandStart;
check(expanded.entries.length === 1, "exact expansion returns one entry");
check(expanded.entries[0]?.structuredContent !== undefined, "exact expansion returns the stored payload");

const migrationFile = path.join(root, "legacy-session.jsonl");
const migrationRows = [{ type: "session", version: 3, id: "legacy-1", cwd: projectCwd, timestamp: "2026-09-01T00:00:00.000Z" }]
  .concat(Array.from({ length: 500 }, (_, index) => makeEntry(99, index)));
fs.writeFileSync(migrationFile, migrationRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const migrationStart = performance.now();
const firstMigration = reconcileSession({ agentDir, ledger: runtime.ledger, files: [migrationFile], liveCwd: projectCwd, projectCwd, apply: true });
const migrationMs = performance.now() - migrationStart;
const secondMigration = reconcileSession({ agentDir, ledger: runtime.ledger, files: [migrationFile], liveCwd: projectCwd, projectCwd, apply: true });
check(firstMigration.counts.imported === 500, "migration imported every row", String(firstMigration.counts.imported));
check(secondMigration.counts.skippedDuplicate === 500, "migration repeat is idempotent", String(secondMigration.counts.skippedDuplicate));
check(secondMigration.counts.imported === 0, "migration repeat imports nothing", String(secondMigration.counts.imported));

const passive = runtime.ledger.checkpoint("passive");
const truncate = runtime.ledger.checkpoint("truncate");
const storage = {
  databaseBytes: fileSize(ledgerPath),
  walBytes: fileSize(ledgerPath + "-wal"),
  operationalState: runtime.ledger.operationalState,
  passiveCheckpoint: passive,
  truncateCheckpoint: truncate,
};

const totalRowsBeforeRestart = runtime.ledger.readRaw(runtime.projectKey).length;
await runtime.shutdown();
const reopened = new LcmLedger({ dbPath: ledgerPath, project: { liveCwd: projectCwd } });
const totalRowsAfterRestart = reopened.readRaw(reopened.project.key).length;
const nodesAfterRestart = reopened.readOnly((db) => db.prepare("SELECT count(*) n FROM summary_nodes WHERE project_key=?").get(reopened.project.key).n);
reopened.close();
check(totalRowsAfterRestart === totalRowsBeforeRestart, "restart preserves every row",
  totalRowsAfterRestart + " vs " + totalRowsBeforeRestart);
check(nodesAfterRestart === nodes.length, "restart preserves every node", nodesAfterRestart + " vs " + nodes.length);

fs.writeFileSync(stopPath, "stop");
await new Promise((resolve) => contender.on("exit", resolve));
const contenderReport = fs.existsSync(contenderReportPath)
  ? JSON.parse(fs.readFileSync(contenderReportPath, "utf8"))
  : { appends: 0, reads: 0, lockErrors: 0, otherErrors: 0 };
check(contenderReport.otherErrors === 0, "competing process saw no unexpected errors", String(contenderReport.otherErrors));

const report = {
  fixture: {
    sessions: SESSIONS,
    entriesPerSession: ENTRIES_PER_SESSION,
    contentBytes: CONTENT_BYTES,
    compactionCycles: CYCLES,
    branchEntriesPerCycle: CYCLE_BRANCH_ENTRIES,
    competingProcesses: 2,
  },
  ingest: {
    rows: ingestedRows,
    totalMs: round(ingestMs),
    perSessionP95Ms: round(percentile(ingestDurations, 0.95)),
    rowsPerSecond: Math.round(ingestedRows / (ingestMs / 1000)),
    duplicateRows: duplicateKeys,
  },
  compaction: {
    cycles: CYCLES,
    p50Ms: round(percentile(hookDurations, 0.5)),
    p95Ms: round(hookP95),
    maxMs: round(Math.max(...hookDurations)),
    modelCalls: hookModelCalls,
    modelCallsPerCompaction: hookModelCalls / CYCLES,
    sources: sourceCounts,
    readyFrontier: {
      cycles: CYCLES,
      p50Ms: round(percentile(repeatDurations, 0.5)),
      p95Ms: round(percentile(repeatDurations, 0.95)),
      maxMs: round(Math.max(...repeatDurations)),
      sources: repeatSources,
    },
  },
  maintenance: { nodes: nodes.length, backlogJobs: backlog, danglingChildren, uncommittedSources },
  recall: { hits: recalled.hits.length, rawHits: rawHits.length, precision: round(recallPrecision), complete: recalled.coverage.complete, reasons: recalled.coverage.reasons, recallMs: round(recallMs), expandMs: round(expandMs) },
  migration: { imported: firstMigration.counts.imported, repeatDuplicates: secondMigration.counts.skippedDuplicate, malformed: firstMigration.counts.malformed, oversized: firstMigration.counts.oversized, ms: round(migrationMs) },
  storage,
  restart: { rowsBefore: totalRowsBeforeRestart, rowsAfter: totalRowsAfterRestart, nodesAfter: nodesAfterRestart },
  competingProcess: contenderReport,
  failures,
};

const outPath = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : path.join(os.tmpdir(), "lcm-benchmark-report.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });

console.log(JSON.stringify(report, null, 2));
console.log("report written to " + outPath);
if (failures.length > 0) {
  console.error("benchmark gate failed:\n" + failures.map((failure) => "  - " + failure).join("\n"));
  process.exit(1);
}
console.log("benchmark gate passed");
