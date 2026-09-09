import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalLcmPayload } from "../../src/storage/lcm-ledger.js";
import { openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";
import { LcmMaintenance } from "../../src/compaction/lcm-maintenance.js";

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

const openQueue = () => {
  const root = tempRoot("lcm-scheduler-");
  const ledger = openLedger({ dbPath: path.join(root, "db.sqlite"), project: { liveCwd: root } });
  const clock = { now: 1_000 };
  const maintenance = new LcmMaintenance(ledger, { now: () => clock.now });
  const add = (entryId: string, sessionId = "s") => ledger.appendRaw(raw(ledger.project.key, sessionId, entryId, `${entryId} evidence`));
  const leafFor = (entryId: string, sessionId = "s") => {
    const node = maintenance.createLeaf([add(entryId, sessionId)]);
    if (!node) throw new Error("missing leaf");
    const job = maintenance.jobForNode(node.nodeId);
    if (!job) throw new Error("missing job");
    return { node, job };
  };
  return { ledger, maintenance, clock, leafFor };
};

afterEach(releaseTemp);

describe("LCM maintenance queue", () => {
  it("still offers pending work behind more completed history than a page shows", () => {
    const { maintenance, clock, leafFor } = openQueue();
    for (let index = 0; index < 105; index += 1) {
      const { job } = leafFor(`history-${String(index).padStart(3, "0")}`);
      maintenance.completeEmergency(maintenance.claimEmergency(job.jobId), `history summary ${index}`);
      clock.now += 1;
    }
    clock.now += 10_000;
    const live = leafFor("live");

    const page = maintenance.listJobs();
    expect(page).toHaveLength(100);
    expect(page.filter((job) => job.state === "pending")).toHaveLength(0);
    expect(page.some((job) => job.nodeId === live.node.nodeId)).toBe(false);

    const claimable = maintenance.claimableJobs("s");
    expect(claimable.map((job) => job.jobId)).toEqual([live.job.jobId]);
    expect(() => maintenance.claim(live.job.jobId)).not.toThrow();
  });

  it("scopes claimable work to one session so a dead session cannot crowd it out", () => {
    const { maintenance, clock, leafFor } = openQueue();
    for (let index = 0; index < 3; index += 1) { leafFor(`dead-${index}`, "dead-session"); clock.now += 1; }
    const live = leafFor("live", "live-session");
    expect(maintenance.claimableJobs("live-session").map((job) => job.jobId)).toEqual([live.job.jobId]);
    expect(maintenance.claimableJobs().length).toBe(4);
  });

  it("prefers a condensation over the leaves it rolls up", () => {
    const { maintenance, clock, leafFor } = openQueue();
    const children = ["a", "b"].map((name) => {
      const { node, job } = leafFor(name);
      maintenance.completeEmergency(maintenance.claimEmergency(job.jobId), `${name} summary`);
      clock.now += 1;
      return maintenance.getNode(node.nodeId)!;
    });
    const late = leafFor("late");
    const condensed = maintenance.createCondensed(children);
    if (!condensed) throw new Error("missing condensed node");
    const claimable = maintenance.claimableJobs("s").map((job) => job.jobId);
    expect(claimable[0]).toBe(`job:${condensed.nodeId}`);
    expect(claimable).toContain(late.job.jobId);
  });

  it("reclaims a running job whose lease expired instead of leaving it to hold the queue", () => {
    const { maintenance, clock, leafFor } = openQueue();
    const { node, job } = leafFor("stuck");
    maintenance.claim(job.jobId);
    expect(maintenance.jobForNode(node.nodeId)?.state).toBe("running");
    expect(maintenance.claimableJobs("s")).toHaveLength(0);

    clock.now += 29_000;
    expect(maintenance.sweepExpiredLeases()).toHaveLength(0);

    clock.now += 2_000;
    expect(maintenance.sweepExpiredLeases(60_000)).toHaveLength(0);
    expect(maintenance.jobForNode(node.nodeId)?.state).toBe("running");

    const swept = maintenance.sweepExpiredLeases();
    expect(swept.map((item) => item.jobId)).toEqual([job.jobId]);
    const reclaimed = maintenance.jobForNode(node.nodeId);
    expect(reclaimed).toMatchObject({ state: "pending", attempts: 0, error: "lease expired" });
    expect(reclaimed?.leaseToken).toBeUndefined();
    expect(maintenance.claimableJobs("s").map((item) => item.jobId)).toEqual([job.jobId]);
  });

  it("keeps an expired-lease sweep off a job another owner still holds", () => {
    const { maintenance, clock, leafFor } = openQueue();
    const { job } = leafFor("held");
    maintenance.claim(job.jobId);
    clock.now += 20_000;
    expect(maintenance.sweepExpiredLeases()).toHaveLength(0);
    expect(maintenance.jobForNode(job.nodeId)?.state).toBe("running");
  });

  it("records a failure for a job that never reached its claim", () => {
    const { maintenance, clock, leafFor } = openQueue();
    const { job } = leafFor("stale");

    const first = maintenance.recordFailure(job, new Error("stale source"));
    expect(first).toMatchObject({ attempts: 1, state: "pending" });
    expect(first?.error).toContain("stale source");
    expect(maintenance.claimableJobs("s")).toHaveLength(0);

    expect(maintenance.recordFailure(job, new Error("stale source"))?.attempts).toBe(1);

    clock.now += 30_000;
    const retry = maintenance.claimableJobs("s")[0];
    expect(retry?.jobId).toBe(job.jobId);

    maintenance.recordFailure(retry!, new Error("stale source"));
    clock.now += 60_000;
    const last = maintenance.claimableJobs("s")[0];
    expect(last?.attempts).toBe(2);
    maintenance.recordFailure(last!, new Error("stale source"));

    expect(maintenance.jobForNode(job.nodeId)?.state).toBe("failed");
    expect(maintenance.countJobs("failed")).toBe(1);
    expect(maintenance.claimableJobs("s")).toHaveLength(0);
  });

  it("never overwrites a completed job with a late failure", () => {
    const { maintenance, leafFor } = openQueue();
    const { job } = leafFor("done");
    maintenance.completeEmergency(maintenance.claimEmergency(job.jobId), "done summary");
    expect(maintenance.recordFailure(job, new Error("too late"))).toMatchObject({ state: "completed", attempts: 0 });
    expect(maintenance.countJobs("failed")).toBe(0);
  });

  it("leaves a job that is only waiting out its backoff untouched", () => {
    const { maintenance, clock, leafFor } = openQueue();
    const { job } = leafFor("backing-off");
    expect(maintenance.isClaimable(job)).toBe(true);
    const failed = maintenance.recordFailure(job, new Error("nope"));
    expect(maintenance.isClaimable(failed!)).toBe(false);
    clock.now += 30_000;
    expect(maintenance.isClaimable(maintenance.jobForNode(job.nodeId)!)).toBe(true);
  });

  it("counts only failures inside the reporting window", () => {
    const { maintenance, clock, leafFor } = openQueue();
    const { job } = leafFor("old");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = maintenance.jobForNode(job.nodeId);
      maintenance.recordFailure(current!, new Error("nope"));
      clock.now += 1_000_000;
    }
    expect(maintenance.countJobs("failed")).toBe(1);
    expect(maintenance.countJobs("failed", clock.now)).toBe(0);
  });
});
