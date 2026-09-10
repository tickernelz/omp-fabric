import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { canonicalLcmPayload, type LcmLedger, type RawEntry } from "../../src/storage/lcm-ledger.js";
import { closeAfterTest, openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";
import { DEFAULT_MAINTENANCE_CONCURRENCY, LEASE_MS, LEASE_SWEEP_GRACE_MS, LcmMaintenance, LcmRejection, type LcmJob, type LcmMaintenanceOptions, type LcmNode } from "../../src/compaction/lcm-maintenance.js";
import { LcmRuntime } from "../../src/compaction/lcm-runtime.js";
import type { LcmModelResult, LcmSummarizer } from "../../src/compaction/lcm-model.js";

const EVIDENCE = "concurrency evidence ".repeat(40);

interface RunSeam { run: (job: LcmJob, model: LcmSummarizer, input: string) => Promise<LcmNode> }
interface SelectLeafSeam { selectLeaf: (entries?: RawEntry[], branch?: string | null) => RawEntry[] }
interface PendingSeam { maintenancePending: Promise<void> }
interface Deferred { promise: Promise<void>; resolve: () => void }

const raw = (projectKey: string, sessionId: string, entryId: string, text: string) => ({
  projectKey,
  sessionId,
  entryId,
  role: "user",
  content: text,
  payloadJson: canonicalLcmPayload({ type: "message", id: entryId, parentId: null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } }),
  parentEntryId: null,
  branch: "main",
  createdAt: 0,
});

const result = (text: string): LcmModelResult => ({ text, inputTokens: 7, outputTokens: 3, cost: 0, wallMs: 11, modelHash: "test" });

const deferred = (): Deferred => {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
};

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

interface SharedLedger {
  first: LcmMaintenance;
  second: LcmMaintenance;
  clock: { now: number };
  ledger: LcmLedger;
  leafFor: (entryId: string, sessionId?: string) => { node: LcmNode; job: LcmJob };
}

const openShared = (options: LcmMaintenanceOptions = {}): SharedLedger => {
  const root = tempRoot("lcm-concurrency-");
  const dbPath = path.join(root, "db.sqlite");
  const clock = { now: 1_000 };
  const ledger = openLedger({ dbPath, project: { liveCwd: root } });
  const second = new LcmMaintenance(openLedger({ dbPath, project: { liveCwd: root } }), { now: () => clock.now, ownerId: "owner-b", ...options });
  const first = new LcmMaintenance(ledger, { now: () => clock.now, ownerId: "owner-a", ...options });
  const leafFor = (entryId: string, sessionId = "s"): { node: LcmNode; job: LcmJob } => {
    const node = first.createLeaf([ledger.appendRaw(raw(ledger.project.key, sessionId, entryId, `${entryId} ${EVIDENCE}`))]);
    if (!node) throw new Error("missing leaf");
    const job = first.jobForNode(node.nodeId);
    if (!job) throw new Error("missing job");
    return { node, job };
  };
  return { first, second, clock, ledger, leafFor };
};

const recordedCalls = (ledger: LcmLedger): number => ledger.readOnly((db) =>
  Number((db.prepare("SELECT coalesce(sum(calls),0) n FROM maintenance_usage WHERE project_key=?").get(ledger.project.key) as { n: number }).n));

afterEach(async () => { vi.useRealTimers(); await releaseTemp(); });

describe("LCM maintenance concurrency", () => {
  it("hands one job to exactly one claimant when two instances race for it", async () => {
    const { first, second, leafFor } = openShared({ maxConcurrentJobs: 4 });
    const { node, job } = leafFor("contested");
    const held = deferred();
    let calls = 0;
    const model: LcmSummarizer = { modelHash: "test", generate: async () => { calls += 1; await held.promise; return result("contested summary"); } };

    const winner = first.run(job, model, EVIDENCE);
    await flush();
    expect(second.jobForNode(node.nodeId)).toMatchObject({ state: "running", ownerId: "owner-a" });

    const loser = second.run(job, model, EVIDENCE).then(() => "completed", (error: unknown) => (error as Error).message);
    held.resolve();

    expect(await loser).toBe("job lease held");
    await winner;
    expect(calls).toBe(1);
    expect(first.listNodes(100).filter((entry) => entry.state === "ready")).toHaveLength(1);
    expect(first.jobForNode(node.nodeId)?.state).toBe("completed");
    expect(first.getNode(node.nodeId)?.text).toBe("contested summary");
  });

  it("fences a claimant that kept a stale view of a job another owner took", () => {
    const { first, second, leafFor } = openShared({ maxConcurrentJobs: 4 });
    const { node, job } = leafFor("fenced");
    first.claim(job.jobId);
    const forged: LcmJob = { ...job, state: "running", ownerId: "owner-b", leaseToken: "forged", leaseUntil: 31_000 };
    expect(() => second.complete(forged, result("stolen"), Buffer.byteLength(EVIDENCE, "utf8"))).toThrow("lease fenced");
    expect(first.getNode(node.nodeId)?.state).toBe("pending");
    expect(first.revisionsOf(node.nodeId)).toHaveLength(0);
  });

  it("admits work up to the configured cap and refuses the claim past it", () => {
    const { first, second, leafFor } = openShared({ maxConcurrentJobs: 2 });
    const jobs = ["a", "b", "c"].map((name) => leafFor(name).job);
    expect(first.claim(jobs[0]!.jobId).ownerId).toBe("owner-a");
    expect(second.claim(jobs[1]!.jobId).ownerId).toBe("owner-b");
    expect(() => first.claim(jobs[2]!.jobId)).toThrow("project lease held");
  });

  it("keeps concurrent claims inside the remaining daily call budget", async () => {
    const { first, ledger, leafFor } = openShared({ maxConcurrentJobs: 4, budget: { calls: 2 } });
    const jobs = ["a", "b", "c", "d", "e", "f"].map((name) => leafFor(name).job);
    const held = deferred();
    let admitted = 0;
    const model: LcmSummarizer = { modelHash: "test", generate: async () => { admitted += 1; await held.promise; return result("budgeted summary"); } };

    const outcomes = jobs.map((job) => first.run(job, model, EVIDENCE).then(() => "completed", (error: unknown) => (error as Error).message));
    await flush();
    expect(admitted).toBe(2);
    held.resolve();
    const settled = await Promise.all(outcomes);

    expect(settled.filter((value) => value === "completed")).toHaveLength(2);
    expect(settled.filter((value) => value === "budget exhausted")).toHaveLength(4);
    expect(first.listNodes(100).filter((node) => node.modelHash === "test")).toHaveLength(2);
    expect(admitted).toBe(recordedCalls(ledger));
    expect(recordedCalls(ledger)).toBe(2);
    expect(() => first.claim(jobs[5]!.jobId)).toThrow("budget exhausted");
  });

  it("keeps concurrent claims inside the remaining session call budget", async () => {
    const { first, leafFor } = openShared({ maxConcurrentJobs: 4, budget: { sessionCalls: 1 } });
    const jobs = ["a", "b", "c"].map((name) => leafFor(name, "one-session").job);
    const held = deferred();
    let admitted = 0;
    const model: LcmSummarizer = { modelHash: "test", generate: async () => { admitted += 1; await held.promise; return result("session summary"); } };

    const outcomes = jobs.map((job) => first.run(job, model, EVIDENCE).then(() => "completed", (error: unknown) => (error as Error).message));
    await flush();
    expect(admitted).toBe(1);
    held.resolve();
    expect(await Promise.all(outcomes)).toEqual(["completed", "budget exhausted", "budget exhausted"]);
  });

  it("publishes one node and one job when two passes cover the same sources", () => {
    const { first, second, ledger, leafFor } = openShared({ maxConcurrentJobs: 4 });
    const shared = ledger.appendRaw(raw(ledger.project.key, "s", "shared", `shared ${EVIDENCE}`));
    const left = first.createLeaf([shared]);
    const right = second.createLeaf([shared]);

    expect(right?.nodeId).toBe(left?.nodeId);
    expect(first.listNodes(100).filter((node) => node.sources.some((source) => source.entryId === "shared"))).toHaveLength(1);
    expect(first.listJobs(100).filter((job) => job.nodeId === left?.nodeId)).toHaveLength(1);

    const parents = ["c1", "c2"].map((name) => {
      const { node, job } = leafFor(name);
      first.completeEmergency(first.claimEmergency(job.jobId), `${name} summary`);
      const stored = first.getNode(node.nodeId);
      if (!stored) throw new Error("missing child");
      return stored;
    });
    const leftCondensed = first.createCondensed(parents);
    const rightCondensed = second.createCondensed(parents);

    expect(rightCondensed?.nodeId).toBe(leftCondensed?.nodeId);
    const condensed = first.listNodes(100).filter((node) => node.kind === "condensed");
    expect(condensed).toHaveLength(1);
    expect(condensed[0]?.children).toEqual(parents.map((parent) => parent.nodeId));
    expect(first.listJobs(100).filter((job) => job.nodeId === leftCondensed?.nodeId)).toHaveLength(1);
  });

  it("keeps every live lease renewable while its siblings renew alongside it", () => {
    const { first, clock, leafFor } = openShared({ maxConcurrentJobs: 3 });
    const claimed = ["a", "b", "c"].map((name) => first.claim(leafFor(name).job.jobId));
    expect(claimed.map((job) => job.leaseUntil)).toEqual([31_000, 31_000, 31_000]);

    clock.now = 11_000;
    const renewedA = first.renew(claimed[0]!);
    clock.now = 16_000;
    const renewedB = first.renew(claimed[1]!);
    clock.now = 21_000;
    const renewedC = first.renew(claimed[2]!);
    expect([renewedA.leaseUntil, renewedB.leaseUntil, renewedC.leaseUntil]).toEqual([41_000, 46_000, 51_000]);

    clock.now = 41_000 + LEASE_SWEEP_GRACE_MS - 1;
    expect(first.sweepExpiredLeases()).toHaveLength(0);
    expect(first.listJobs(100).filter((job) => job.state === "running")).toHaveLength(3);

    clock.now = 41_000 + LEASE_SWEEP_GRACE_MS;
    expect(first.sweepExpiredLeases().map((job) => job.jobId)).toEqual([renewedA.jobId]);
    expect(first.listJobs(100).filter((job) => job.state === "running")).toHaveLength(2);

    clock.now = 46_000 + LEASE_SWEEP_GRACE_MS;
    expect(first.sweepExpiredLeases().map((job) => job.jobId)).toEqual([renewedB.jobId]);

    clock.now = 51_000 + LEASE_SWEEP_GRACE_MS;
    expect(first.sweepExpiredLeases().map((job) => job.jobId)).toEqual([renewedC.jobId]);
  });

  it("keeps a stalled call inside the cap until its slot is reclaimable", async () => {
    const { first, second, clock, ledger, leafFor } = openShared({ maxConcurrentJobs: 3, budget: { calls: 3 } });
    const jobs = ["a", "b", "c", "d", "e", "f"].map((name) => leafFor(name).job);
    const held = deferred();
    let inFlight = 0;
    let peak = 0;
    const model: LcmSummarizer = { modelHash: "test", generate: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await held.promise; inFlight -= 1; return result("stalled summary"); } };

    const stalled = jobs.slice(0, 3).map((job) => first.run(job, model, EVIDENCE).then(() => "completed", (error: unknown) => (error as Error).message));
    await flush();
    expect(inFlight).toBe(3);
    expect(() => second.claim(jobs[3]!.jobId)).toThrow("project lease held");

    clock.now = 1_000 + LEASE_MS + 1;
    expect(first.listJobs(100).filter((job) => job.state === "running")).toHaveLength(3);
    expect(await Promise.all(jobs.slice(3).map((job) => second.run(job, model, EVIDENCE).then(() => "completed", (error: unknown) => (error as Error).message))))
      .toEqual(["project lease held", "project lease held", "project lease held"]);
    expect(peak).toBe(3);
    expect(second.withinBudget("s")).toBe(false);

    held.resolve();
    expect(await Promise.all(stalled)).toEqual(["lease fenced", "lease fenced", "lease fenced"]);
    expect(recordedCalls(ledger)).toBe(0);
    expect(first.listNodes(100).filter((node) => node.state === "ready")).toHaveLength(0);
    expect(first.listJobs(100).every((job) => job.attempts === 0)).toBe(true);

    clock.now = 1_000 + LEASE_MS + LEASE_SWEEP_GRACE_MS;
    expect(first.sweepExpiredLeases()).toHaveLength(3);
    expect(second.claim(jobs[3]!.jobId).ownerId).toBe("owner-b");
  });

  it("keeps a lapsed lease reserved against the call budget until its slot is reclaimable", () => {
    const { first, second, clock, leafFor } = openShared({ maxConcurrentJobs: 6, budget: { calls: 3 } });
    const jobs = ["a", "b", "c", "d"].map((name) => leafFor(name).job);
    for (const job of jobs.slice(0, 3)) first.claim(job.jobId);
    expect(() => second.claim(jobs[3]!.jobId)).toThrow("budget exhausted");

    clock.now = 1_000 + LEASE_MS + 1;
    expect(() => second.claim(jobs[3]!.jobId)).toThrow("budget exhausted");
    expect(second.withinBudget("s")).toBe(false);

    clock.now = 1_000 + LEASE_MS + LEASE_SWEEP_GRACE_MS;
    expect(first.sweepExpiredLeases()).toHaveLength(3);
    expect(second.claim(jobs[3]!.jobId).ownerId).toBe("owner-b");
  });

  it("leaves a job retired by a real failure whose text reads like a refusal", () => {
    const { first, leafFor } = openShared({ maxConcurrentJobs: 3 });
    const retire = (job: LcmJob, error: unknown): LcmJob => {
      let current = job;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = first.recordFailure(current, error);
        if (!next) throw new Error("missing job");
        current = next;
      }
      return current;
    };
    const aborted = new Error("job not eligible");
    aborted.name = "AbortError";
    const overspent = retire(leafFor("overspent").job, new Error("budget exhausted"));
    const provider = retire(leafFor("provider").job, aborted);
    expect([overspent.error, provider.error]).toEqual(["Error: budget exhausted", "AbortError: job not eligible"]);
    expect([overspent.state, provider.state]).toEqual(["failed", "failed"]);

    expect(first.recoverLegacyContentionRetirements()).toHaveLength(0);
    expect(first.listJobs(100).filter((job) => job.state === "failed").map((job) => job.jobId).sort())
      .toEqual([overspent.jobId, provider.jobId].sort());
  });

  it("recovers a contention retirement an earlier release wrote exactly once", () => {
    const { first, ledger, leafFor } = openShared({ maxConcurrentJobs: 3 });
    const { node, job } = leafFor("legacy");
    const retire = (payload: LcmJob): void => {
      ledger.transaction((db) => db.prepare("UPDATE maintenance_jobs SET status=?,payload=? WHERE job_id=? AND project_key=?")
        .run("failed", JSON.stringify({ ...payload, state: "failed", attempts: 3, error: "LcmRejection: project lease held" }), payload.jobId, ledger.project.key));
    };
    retire(job);

    const recovered = first.recoverLegacyContentionRetirements();
    expect(recovered).toHaveLength(1);
    expect(first.jobForNode(node.nodeId)).toMatchObject({ state: "pending", attempts: 0, legacyRecovery: true });
    expect(first.jobForNode(node.nodeId)?.error).toBeUndefined();
    expect(first.recoverLegacyContentionRetirements()).toHaveLength(0);

    retire(recovered[0]!);
    expect(first.recoverLegacyContentionRetirements()).toHaveLength(0);
    expect(first.jobForNode(node.nodeId)).toMatchObject({ state: "failed", attempts: 3 });
  });

  it("stops at the token, cost and wall-time budgets without paying for a refused call", async () => {
    const usage = { inputTokens: 7, outputTokens: 3, cost: 0.5, wallMs: 11 };
    for (const dimension of ["inputTokens", "outputTokens", "cost", "wallMs"] as const) {
      const per = usage[dimension];
      const { first, ledger, leafFor } = openShared({ maxConcurrentJobs: 4, budget: { [dimension]: per * 3 - per / 2 } });
      let admitted = 0;
      const model: LcmSummarizer = { modelHash: "test", generate: async () => { admitted += 1; return { text: `${dimension} summary`, ...usage, modelHash: "test" }; } };
      const outcomes: string[] = [];
      for (const name of ["a", "b", "c", "d"]) {
        const job = leafFor(`${dimension}-${name}`).job;
        outcomes.push(await first.run(job, model, EVIDENCE).then(() => "completed", (error: unknown) => (error as Error).message));
      }
      expect(outcomes).toEqual(["completed", "completed", "budget exhausted", "budget exhausted"]);
      expect(admitted).toBe(2);
      expect(recordedCalls(ledger)).toBe(2);
    }
  });
});

const makeEntry = (id: string, text: string, parentId: string | null): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
} as SessionEntry);

const makeContext = (root: string, entries: SessionEntry[]): ExtensionContext => ({
  cwd: root,
  model: undefined,
  modelRegistry: {} as ExtensionContext["modelRegistry"],
  sessionManager: {
    getRecordedCwd: () => root,
    getSessionFile: () => undefined,
    getSessionId: () => "session-1",
    getLeafId: () => "branch-a",
    getBranch: () => entries,
  },
} as unknown as ExtensionContext);

interface Backlog {
  runtime: LcmRuntime;
  started: string[];
  finished: string[];
  gates: Map<string, () => void>;
  passes: () => number;
  settle: () => Promise<void>;
  setConcurrency: (value: number) => void;
}

const stageBacklog = async (options: { concurrency: number; passes: number; runSeconds: number }): Promise<Backlog> => {
  const root = tempRoot("lcm-dispatch-");
  const entries = Array.from({ length: 8 }, (_, index) =>
    makeEntry(`e${index}`, `dispatch source ${index} ${EVIDENCE}`, index === 0 ? null : `e${index - 1}`));
  const knob = { concurrency: options.concurrency };
  const runtime = closeAfterTest(new LcmRuntime(makeContext(root, entries), () => ({
    rootDir: root,
    maxLeafEntries: 1,
    maxCondenseChildren: 32,
    maxMaintenancePasses: options.passes,
    maintenanceConcurrency: knob.concurrency,
    maintenanceRunSeconds: options.runSeconds,
  })), (value) => value.shutdown());
  await runtime.readback();
  for (const row of runtime.raw("session-1")) runtime.maintenance.createLeaf([row]);

  const started: string[] = [];
  const finished: string[] = [];
  const gates = new Map<string, () => void>();
  const runSeam = runtime.maintenance as unknown as RunSeam;
  runSeam.run = async (job: LcmJob, _model: LcmSummarizer, input: string): Promise<LcmNode> => {
    started.push(job.nodeId);
    const claimed = runtime.maintenance.claim(job.jobId);
    const held = deferred();
    gates.set(job.nodeId, held.resolve);
    await held.promise;
    finished.push(job.nodeId);
    return runtime.maintenance.complete(claimed, result(`summary for ${job.nodeId}`), Buffer.byteLength(input, "utf8"));
  };

  let passes = 0;
  const leafSeam = runtime.maintenance as unknown as SelectLeafSeam;
  const selectLeaf = leafSeam.selectLeaf.bind(runtime.maintenance);
  leafSeam.selectLeaf = (entriesArg, branch) => { passes += 1; return selectLeaf(entriesArg, branch); };

  const pending = runtime as unknown as PendingSeam;
  return { runtime, started, finished, gates, passes: () => passes, settle: () => pending.maintenancePending, setConcurrency: (value: number) => { knob.concurrency = value; } };
};

const drain = async (backlog: Backlog, steps = 60): Promise<void> => {
  let done = false;
  void backlog.settle().then(() => { done = true; });
  for (let step = 0; step < steps && !done; step += 1) {
    for (const open of [...backlog.gates.values()]) open();
    await flush();
  }
  await backlog.settle();
};

const openNext = (backlog: Backlog, slow: string): boolean => {
  const open = backlog.started.find((nodeId) => nodeId !== slow && !backlog.finished.includes(nodeId));
  if (!open) return false;
  backlog.gates.get(open)?.();
  return true;
};

describe("LCM emergency compaction under a held lease", () => {
  const stageEmergency = async (): Promise<{ runtime: LcmRuntime; entries: SessionEntry[]; job: LcmJob; nodeId: string }> => {
    const root = tempRoot("lcm-emergency-");
    const entries = Array.from({ length: 3 }, (_, index) =>
      makeEntry(`e${index}`, `emergency source ${index} ${EVIDENCE}`, index === 0 ? null : `e${index - 1}`));
    const runtime = closeAfterTest(new LcmRuntime(makeContext(root, entries), () => ({ rootDir: root, maxLeafEntries: 8 })), (value) => value.shutdown());
    await runtime.readback();
    const leaf = runtime.maintenance.createLeaf(runtime.raw("session-1").slice(0, 2));
    if (!leaf) throw new Error("missing leaf");
    const job = runtime.maintenance.jobForNode(leaf.nodeId);
    if (!job) throw new Error("missing job");
    return { runtime, entries, job, nodeId: leaf.nodeId };
  };
  const compact = (runtime: LcmRuntime, entries: SessionEntry[]) =>
    runtime.compact({ branchEntries: entries, sessionId: "session-1", branch: "branch-a", firstKeptEntryId: "e2", tokensBefore: 1_000 });

  it("serves the excerpt instead of cancelling when a dead worker still holds the leaf", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { runtime, entries, job, nodeId } = await stageEmergency();
    runtime.maintenance.claim(job.jobId, "dead-owner");

    vi.setSystemTime(start + LEASE_MS + 1);
    const output = compact(runtime, entries);

    expect(output.source).toBe("emergency");
    expect(output.summary.length).toBeGreaterThan(0);
    expect(runtime.maintenance.getNode(nodeId)).toMatchObject({ state: "ready", modelHash: "emergency" });
    await runtime.shutdown();
  });

  it("serves the excerpt instead of cancelling while a live worker holds the leaf", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { runtime, entries, job, nodeId } = await stageEmergency();
    runtime.maintenance.claim(job.jobId, "live-owner");

    const output = compact(runtime, entries);

    expect(output.source).toBe("emergency");
    expect(output.summary.length).toBeGreaterThan(0);
    expect(runtime.maintenance.getNode(nodeId)?.state).toBe("pending");
    expect(runtime.maintenance.jobForNode(nodeId)).toMatchObject({ state: "running", ownerId: "live-owner" });
    await runtime.shutdown();
  });
});

describe("LCM runtime concurrent dispatch", () => {
  it("gives maintenance the configured cap and the shipped default when none is set", async () => {
    const root = tempRoot("lcm-default-");
    const shipped = closeAfterTest(new LcmRuntime(makeContext(root, []), { rootDir: root }), (value) => value.shutdown());
    expect(shipped.maintenance.concurrencyLimit).toBe(DEFAULT_MAINTENANCE_CONCURRENCY);
    expect(DEFAULT_MAINTENANCE_CONCURRENCY).toBe(3);
    await shipped.shutdown();

    let configured = 1;
    const live = closeAfterTest(new LcmRuntime(makeContext(root, []), () => ({ rootDir: root, maintenanceConcurrency: configured })), (value) => value.shutdown());
    expect(live.maintenance.concurrencyLimit).toBe(1);
    configured = 6;
    expect(live.maintenance.concurrencyLimit).toBe(6);
    await live.shutdown();
  });

  it("keeps a slow job from stranding the rest of the batch", async () => {
    const backlog = await stageBacklog({ concurrency: 3, passes: 8, runSeconds: 600 });
    backlog.runtime.scheduleMaintenance();
    await flush();
    expect(backlog.started).toHaveLength(3);

    const slow = backlog.started[0]!;
    for (let step = 0; step < 7; step += 1) {
      if (!openNext(backlog, slow)) break;
      await flush();
    }

    expect(backlog.finished).toHaveLength(7);
    expect(backlog.finished).not.toContain(slow);
    expect(backlog.started).toHaveLength(8);

    backlog.gates.get(slow)?.();
    await backlog.settle();
    expect(backlog.finished).toHaveLength(8);
    expect(backlog.runtime.maintenance.listJobs(100).filter((job) => job.state === "pending")).toHaveLength(0);
    await backlog.runtime.shutdown();
  });

  it("stops dispatching at the run deadline and inside the pass limit when a job is slow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const backlog = await stageBacklog({ concurrency: 2, passes: 4, runSeconds: 1 });
    backlog.runtime.scheduleMaintenance();
    await flush();
    expect(backlog.started).toHaveLength(2);
    const slow = backlog.started[0]!;

    for (const offset of [400, 800, 1_200]) {
      vi.setSystemTime(start + offset);
      openNext(backlog, slow);
      await flush();
    }
    expect(backlog.started).toHaveLength(4);

    vi.setSystemTime(start + 2_500);
    backlog.gates.get(slow)?.();
    await backlog.settle();

    expect(backlog.started).toHaveLength(4);
    expect(backlog.passes()).toBe(1);
    expect(backlog.runtime.maintenance.listJobs(100).filter((job) => job.state === "pending")).toHaveLength(4);
    await backlog.runtime.shutdown();
  });

  it("retires surplus workers without charging an attempt when the cap is lowered mid-run", async () => {
    const backlog = await stageBacklog({ concurrency: 3, passes: 8, runSeconds: 600 });
    backlog.runtime.scheduleMaintenance();
    await flush();
    expect(backlog.started).toHaveLength(3);

    backlog.setConcurrency(1);
    await drain(backlog);

    const jobs = backlog.runtime.maintenance.listJobs(100);
    expect(jobs).toHaveLength(8);
    expect(jobs.filter((job) => job.attempts > 0)).toHaveLength(0);
    expect(jobs.filter((job) => job.state !== "completed")).toHaveLength(0);
    expect(backlog.finished).toHaveLength(8);
    expect(String(backlog.runtime.error ?? "")).not.toContain("lease");
    await backlog.runtime.shutdown();
  });

  it("retires a surplus worker while the remaining lease of a lowered cap is still held", async () => {
    const backlog = await stageBacklog({ concurrency: 3, passes: 8, runSeconds: 600 });
    backlog.runtime.scheduleMaintenance();
    await flush();
    expect(backlog.started).toHaveLength(3);

    const leader = backlog.started[0]!;
    backlog.setConcurrency(1);
    for (const nodeId of backlog.started.slice(1)) backlog.gates.get(nodeId)?.();
    for (let step = 0; step < 4; step += 1) await flush();

    expect(backlog.finished).toHaveLength(2);
    expect(backlog.started).toHaveLength(3);
    const running = backlog.runtime.maintenance.listJobs(100).filter((job) => job.state === "running");
    expect(running.map((job) => job.nodeId)).toEqual([leader]);

    backlog.gates.get(leader)?.();
    await drain(backlog);
    expect(backlog.finished).toHaveLength(8);
    expect(backlog.runtime.maintenance.listJobs(100).filter((job) => job.attempts > 0)).toHaveLength(0);
    await backlog.runtime.shutdown();
  });

  it("leaves a job untouched when another owner holds the project cap", async () => {
    const backlog = await stageBacklog({ concurrency: 1, passes: 8, runSeconds: 600 });
    const outsider = backlog.runtime.maintenance.claim(backlog.runtime.maintenance.listJobs(100)[7]!.jobId, "outsider");
    backlog.runtime.scheduleMaintenance();
    await backlog.settle();

    expect(backlog.started.length).toBeGreaterThan(0);
    expect(backlog.finished).toHaveLength(0);
    const others = backlog.runtime.maintenance.listJobs(100).filter((job) => job.jobId !== outsider.jobId);
    expect(others.filter((job) => job.attempts > 0)).toHaveLength(0);
    expect(others.filter((job) => job.state !== "pending")).toHaveLength(0);
    expect(String(backlog.runtime.error ?? "")).not.toContain("lease");
    await backlog.runtime.shutdown();
  });

  it("heals a job an earlier release retired for contention and leaves a broken one retired", async () => {
    const backlog = await stageBacklog({ concurrency: 3, passes: 8, runSeconds: 600 });
    const retire = (job: LcmJob, error: unknown): LcmJob => {
      let current = job;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = backlog.runtime.maintenance.recordFailure(current, error);
        if (!next) throw new Error("missing job");
        current = next;
      }
      return current;
    };
    const jobs = backlog.runtime.maintenance.listJobs(100);
    const contended = retire(jobs[0]!, new LcmRejection("project lease held"));
    const broken = retire(jobs[1]!, new Error("model unavailable"));
    expect([contended.state, broken.state]).toEqual(["failed", "failed"]);
    expect(backlog.runtime.maintenance.isClaimable(contended)).toBe(false);

    backlog.runtime.scheduleMaintenance();
    await drain(backlog);

    const healed = backlog.runtime.maintenance.listJobs(100);
    expect(healed.find((job) => job.jobId === contended.jobId)).toMatchObject({ state: "completed", attempts: 0, legacyRecovery: true });
    expect(healed.find((job) => job.jobId === broken.jobId)).toMatchObject({ state: "failed", attempts: 3 });
    await backlog.runtime.shutdown();
  });

  it("keeps every job of a stalled batch when the stall fences their completions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const backlog = await stageBacklog({ concurrency: 3, passes: 8, runSeconds: 600 });
    backlog.runtime.scheduleMaintenance();
    await flush();
    const stalled = [...backlog.started];
    expect(stalled).toHaveLength(3);

    vi.setSystemTime(start + LEASE_MS + LEASE_SWEEP_GRACE_MS + 1);
    await drain(backlog);

    const jobs = backlog.runtime.maintenance.listJobs(100);
    expect(jobs.filter((job) => stalled.includes(job.nodeId))).toHaveLength(3);
    expect(jobs.filter((job) => stalled.includes(job.nodeId) && job.attempts > 0)).toHaveLength(0);
    expect(jobs.filter((job) => job.state === "failed")).toHaveLength(0);
    await backlog.runtime.shutdown();
  });
});
