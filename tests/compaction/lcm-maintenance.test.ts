import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalLcmPayload } from "../../src/storage/lcm-ledger.js";
import { openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";
import { LcmMaintenance } from "../../src/compaction/lcm-maintenance.js";
import { emergencyReduce, type LcmModelResult, type LcmSummarizer } from "../../src/compaction/lcm-model.js";

const raw = (projectKey: string, sessionId: string, entryId: string, text: string, branch: string | null) => ({ projectKey, sessionId, entryId, role: "user", content: text, payloadJson: canonicalLcmPayload({ type: "message", id: entryId, parentId: null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } }), parentEntryId: null, branch, createdAt: 0 });
const result = (text: string): LcmModelResult => ({ text, inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" });
const model = (value: LcmModelResult): LcmSummarizer => ({ modelHash: value.modelHash, generate: async () => value });
const open = (options: ConstructorParameters<typeof LcmMaintenance>[1] = {}) => { const root = tempRoot("lcm-maintenance-"); const ledger = openLedger({ dbPath: path.join(root, "db.sqlite"), project: { liveCwd: root } }); return { ledger, maintenance: new LcmMaintenance(ledger, options) }; };
afterEach(releaseTemp);

describe("LCM maintenance branch isolation", () => {
  it("selects only summaries whose source refs are on the active branch", async () => {
    const { ledger, maintenance } = open(); const project = ledger.project.key; const root = ledger.appendRaw(raw(project, "s", "root", "root", null)); const left = ledger.appendRaw(raw(project, "s", "left", "left", "left")); const right = ledger.appendRaw(raw(project, "s", "right", "right", "right"));
    const leftNode = maintenance.createLeaf([root, left]); const rightNode = maintenance.createLeaf([root, right]); if (!leftNode || !rightNode) throw new Error("missing leaf");
    await maintenance.run(maintenance.listJobs().find(j => j.nodeId === leftNode.nodeId)!, model(result("left")), "left"); await maintenance.run(maintenance.listJobs().find(j => j.nodeId === rightNode.nodeId)!, model(result("right")), "right");
    expect(maintenance.getFrontier("s", undefined, new Set(["s:root:1", "s:left:1"])).map(n => n.text)).toEqual(["left"]); expect(maintenance.getFrontier("s", undefined, new Set(["s:root:1", "s:right:1"])).map(n => n.text)).toEqual(["right"]); ledger.close();
  });
  it("retains shared null ancestors during fork leaf selection", async () => {
    const { ledger, maintenance } = open(); const project = ledger.project.key; const root = ledger.appendRaw(raw(project, "s", "root", "root", null)); const left = ledger.appendRaw(raw(project, "s", "left", "left", "left")); const right = ledger.appendRaw(raw(project, "s", "right", "right", "right"));
    const leftNode = maintenance.createLeaf([root, left]); if (!leftNode) throw new Error("missing leaf"); await maintenance.run(maintenance.listJobs().find(j => j.nodeId === leftNode.nodeId)!, model(result("left")), "left");
    expect(maintenance.selectLeaf([{ ...root, branch: null }, right], "right").map(entry => entry.entryId)).toEqual(["root", "right"]); ledger.close();
  });
  it("filters shared-prefix sibling frontiers by branch", async () => {
    const { ledger, maintenance } = open(); const project = ledger.project.key; const root = ledger.appendRaw(raw(project, "s", "root", "root", null)); const left = ledger.appendRaw(raw(project, "s", "left", "left", "left")); const right = ledger.appendRaw(raw(project, "s", "right", "right", "right"));
    const leftNode = maintenance.createLeaf([root, left]); const rightNode = maintenance.createLeaf([root, right]); if (!leftNode || !rightNode) throw new Error("missing leaf");
    await maintenance.run(maintenance.listJobs().find(j => j.nodeId === leftNode.nodeId)!, model(result("left")), "left"); await maintenance.run(maintenance.listJobs().find(j => j.nodeId === rightNode.nodeId)!, model(result("right")), "right");
    const scope = new Set(["s:root:1", "s:left:1", "s:right:1"]);
    expect(maintenance.getFrontier("s", "left", scope).map(n => n.text)).toEqual(["left"]);
    expect(maintenance.getFrontier("s", "right", scope).map(n => n.text)).toEqual(["right"]);
    expect(maintenance.selectCondensation("s", scope, "left").map(n => n.nodeId)).toEqual([leftNode.nodeId]);
    expect(maintenance.selectCondensation("s", scope, "right").map(n => n.nodeId)).toEqual([rightNode.nodeId]);
    ledger.close();
  });
  it("rejects forged maintenance identifiers across projects", () => {
    const firstRoot = tempRoot("lcm-maintenance-project-"); const secondRoot = tempRoot("lcm-maintenance-project-"); const dbPath = path.join(firstRoot, "shared.sqlite"); const firstLedger = openLedger({ dbPath, project: { liveCwd: firstRoot } }); const secondLedger = openLedger({ dbPath, project: { liveCwd: secondRoot } }); const secondMaintenance = new LcmMaintenance(secondLedger); const source = secondLedger.appendRaw(raw(secondLedger.project.key, "payload", "foreign", "foreign", "main")); const node = secondMaintenance.createLeaf([source]); if (!node) throw new Error("missing foreign leaf"); const job = secondMaintenance.listJobs()[0]; if (!job) throw new Error("missing foreign job"); const firstMaintenance = new LcmMaintenance(firstLedger); expect(() => firstMaintenance.createLeaf([source])).toThrow("entry project does not match ledger project"); expect(firstMaintenance.getNode(node.nodeId)).toBeUndefined(); expect(() => firstMaintenance.claim(job.jobId)).toThrow("job not found"); expect(() => firstMaintenance.completeEmergency({ ...job, projectKey: firstLedger.project.key }, "forged")).toThrow("job not found"); firstLedger.close(); secondLedger.close();
  });
  it("scopes leaf identity by branch and policy", () => {
    const { ledger } = open(); const source = ledger.appendRaw(raw(ledger.project.key, "s", "same", "same", "left"));
    const left = new LcmMaintenance(ledger, { policyHash: "policy-a" }); const right = new LcmMaintenance(ledger, { policyHash: "policy-b" });
    const leftNode = left.createLeaf([source]); const rightNode = right.createLeaf([{ ...source, branch: "right" }]); if (!leftNode || !rightNode) throw new Error("missing leaf");
    expect(leftNode.nodeId).not.toBe(rightNode.nodeId); expect(leftNode.branch).toBe("left"); expect(rightNode.branch).toBe("right"); expect(() => left.createLeaf([source, { ...source, branch: "right" }])).toThrow("cross-branch ranges"); ledger.close();
  });
  it("recovers a failed leaf through the emergency lease", () => {
    let now = 1_000; const root = tempRoot("lcm-maintenance-"); const ledger = openLedger({ dbPath: path.join(root, "db.sqlite"), project: { liveCwd: root } }); const maintenance = new LcmMaintenance(ledger, { now: () => now }); const source = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main")); const node = maintenance.createLeaf([source]); if (!node) throw new Error("missing leaf"); let job = maintenance.listJobs()[0]; if (!job) throw new Error("missing job");
    for (let attempt = 0; attempt < 3; attempt += 1) { job = maintenance.fail(maintenance.claim(job.jobId), "model failed"); now += 1_000_000; }
    const ready = maintenance.completeEmergency(maintenance.claimEmergency(job.jobId), "fallback"); expect(ready.state).toBe("ready"); expect(ready.text).toBe("fallback"); expect(maintenance.listJobs()[0]?.state).toBe("completed"); ledger.close();
  });
  it("fails closed when a maintenance lease is held", async () => {
    const { ledger, maintenance } = open(); const other = new LcmMaintenance(ledger, { ownerId: "other" }); const source = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main")); const node = maintenance.createLeaf([source]); if (!node) throw new Error("missing leaf"); const job = maintenance.listJobs()[0]; if (!job) throw new Error("missing job"); maintenance.claim(job.jobId); await expect(other.run(job, model(result("unused")), source.payloadJson)).rejects.toThrow("job lease held"); expect(maintenance.listJobs()[0]?.state).toBe("running"); ledger.close();
  });
  it("honors the configured prompt input bound", async () => {
    const { ledger } = open(); const maintenance = new LcmMaintenance(ledger, { maxInputChars: 1_024 }); const source = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main")); const node = maintenance.createLeaf([source]); if (!node) throw new Error("missing leaf"); const job = maintenance.listJobs()[0]; if (!job) throw new Error("missing job"); let prompt = ""; await maintenance.run(job, { modelHash: "test", generate: async (request) => { prompt = request.prompt; return result("bounded"); } }, "x".repeat(10_000)); expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(1_024); ledger.close();
  });
  it("rejects over-limit emergency summaries", () => {
    const { ledger } = open(); const maintenance = new LcmMaintenance(ledger, { maxOutputChars: 1_024 }); const source = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main")); const node = maintenance.createLeaf([source]); if (!node) throw new Error("missing leaf"); const job = maintenance.listJobs()[0]; if (!job) throw new Error("missing job"); const claimed = maintenance.claimEmergency(job.jobId); expect(() => maintenance.completeEmergency(claimed, "x".repeat(1_025))).toThrow("summary exceeds output bound"); ledger.close();
  });
  it("promotes shared null ancestry into a concrete condensed branch", async () => {
    const { ledger, maintenance } = open(); const project = ledger.project.key; const root = ledger.appendRaw(raw(project, "s", "root", "root", null)); const tail = ledger.appendRaw(raw(project, "s", "tail", "tail", "left")); const shared = maintenance.createLeaf([root]); const branch = maintenance.createLeaf([root, tail]); if (!shared || !branch) throw new Error("missing leaf");
    await maintenance.run(maintenance.listJobs().find(j => j.nodeId === shared.nodeId)!, model(result("shared")), "shared"); await maintenance.run(maintenance.listJobs().find(j => j.nodeId === branch.nodeId)!, model(result("branch")), "branch"); const children = maintenance.selectCondensation("s", new Set(["s:root:1", "s:tail:1"]), "left"); const parent = maintenance.createCondensed(children); if (!parent) throw new Error("missing condensed node"); expect(parent.branch).toBe("left"); expect(parent.sources).toHaveLength(2); ledger.close();
  });
  it("condenses ready nodes once and exposes the parent as the frontier", async () => {
    const { ledger, maintenance } = open(); const project = ledger.project.key; const a = ledger.appendRaw(raw(project, "s", "a", "a", "left")); const b = ledger.appendRaw(raw(project, "s", "b", "b", "left")); const na = maintenance.createLeaf([a]); const nb = maintenance.createLeaf([b]); if (!na || !nb) throw new Error("missing leaf");
    for (const node of [na, nb]) await maintenance.run(maintenance.listJobs().find(j => j.nodeId === node.nodeId)!, model(result(node.nodeId)), node.nodeId); const scope = new Set(["s:a:1", "s:b:1"]); const selected = maintenance.selectCondensation("s", scope); expect(selected.map(n => n.nodeId)).toEqual([na.nodeId, nb.nodeId].sort()); const parent = maintenance.createCondensed(selected); if (!parent) throw new Error("missing parent"); const parentJob = maintenance.listJobs().find(j => j.nodeId === parent.nodeId); if (!parentJob) throw new Error("missing parent job"); await maintenance.run(parentJob, model(result("condensed")), "condensed"); expect(maintenance.selectCondensation("s", scope)).toEqual([]); expect(maintenance.getFrontier("s", undefined, scope).map(n => n.nodeId)).toEqual([parent.nodeId]); ledger.close();
  });
  it("scopes summary node identities by project", () => { const first=open(); const second=open(); const firstEntry=first.ledger.appendRaw(raw(first.ledger.project.key,"s","same","same","main")); const secondEntry=second.ledger.appendRaw(raw(second.ledger.project.key,"s","same","same","main")); const firstNode=first.maintenance.createLeaf([firstEntry]); const secondNode=second.maintenance.createLeaf([secondEntry]); if (!firstNode || !secondNode) throw new Error("missing leaf"); expect(firstNode.nodeId).not.toBe(secondNode.nodeId); first.ledger.close(); second.ledger.close(); });
  it("rejects mixed-branch condensation even when both sources are active", async () => { const { ledger, maintenance } = open(); const left = ledger.appendRaw(raw(ledger.project.key, "s", "left", "left", "left")); const right = ledger.appendRaw(raw(ledger.project.key, "s", "right", "right", "right")); const leftNode = maintenance.createLeaf([left]); const rightNode = maintenance.createLeaf([right]); if (!leftNode || !rightNode) throw new Error("missing leaves"); for (const node of [leftNode, rightNode]) { const job = maintenance.listJobs().find((item) => item.nodeId === node.nodeId); if (!job) throw new Error("missing job"); await maintenance.run(job, model(result(node.nodeId)), node.nodeId); } const forged = { ...maintenance.getNode(leftNode.nodeId)!, projectKey: "other-project" }; expect(() => maintenance.createCondensed([forged, maintenance.getNode(rightNode.nodeId)!])).toThrow("child payload changed"); expect(() => maintenance.createCondensed([maintenance.getNode(leftNode.nodeId)!, maintenance.getNode(rightNode.nodeId)!])).toThrow("cross-branch ranges"); ledger.close(); });
  it("does not condense nodes from another session", async () => {
    const { ledger, maintenance } = open(); const project = ledger.project.key; const a = ledger.appendRaw(raw(project, "s1", "a", "a", "left")); const b = ledger.appendRaw(raw(project, "s2", "b", "b", "left")); const na = maintenance.createLeaf([a]); const nb = maintenance.createLeaf([b]); if (!na || !nb) throw new Error("missing leaf");
    for (const node of [na, nb]) await maintenance.run(maintenance.listJobs().find(j => j.nodeId === node.nodeId)!, model(result(node.nodeId)), node.nodeId); expect(maintenance.selectCondensation("s1", new Set(["s1:a:1", "s2:b:1"])).map(n => n.sessionId)).toEqual(["s1"]); ledger.close();
  });
  it("rejects the next model call at exact project and session caps", async () => {
    const { ledger } = open();
    const limited = new LcmMaintenance(ledger, { budget: { calls: 1, inputTokens: 1, outputTokens: 1, sessionCalls: 1 } });
    const first = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main"));
    const firstNode = limited.createLeaf([first]);
    if (!firstNode) throw new Error("missing first leaf");
    const firstJob = limited.listJobs()[0];
    if (!firstJob) throw new Error("missing first job");
    await limited.run(firstJob, model(result("first")), first.payloadJson);
    const second = ledger.appendRaw(raw(ledger.project.key, "s", "b", "B", "main"));
    const secondNode = limited.createLeaf([second]);
    if (!secondNode) throw new Error("missing second leaf");
    const secondJob = limited.listJobs().find((job) => job.nodeId === secondNode.nodeId);
    if (!secondJob) throw new Error("missing second job");
    await expect(limited.run(secondJob, model(result("second")), second.payloadJson)).rejects.toThrow("budget exhausted");
    expect(limited.listJobs().find((job) => job.nodeId === secondNode.nodeId)?.state).toBe("pending");
    expect((ledger.db.prepare("SELECT calls,input_tokens,output_tokens FROM maintenance_usage").get() as { calls: number; input_tokens: number; output_tokens: number })).toEqual({ calls: 1, input_tokens: 1, output_tokens: 1 });
    ledger.close();
  });

  it("enforces configured cost and wall-time budgets", async () => {
    const { ledger, maintenance } = open(); const limited = new LcmMaintenance(ledger, { budget: { calls: 10, inputTokens: 10, outputTokens: 10, cost: 1, wallMs: 1, sessionCalls: 10 } }); const first = ledger.appendRaw(raw(ledger.project.key, "s", "first", "first", "main")); const firstNode = limited.createLeaf([first]); if (!firstNode) throw new Error("missing leaf"); const firstJob = limited.listJobs()[0]; if (!firstJob) throw new Error("missing job"); await limited.run(firstJob, model({ ...result("first"), cost: 1, wallMs: 1 }), first.payloadJson); const second = ledger.appendRaw(raw(ledger.project.key, "s", "second", "second", "main")); const secondNode = limited.createLeaf([second]); if (!secondNode) throw new Error("missing leaf"); const secondJob = limited.listJobs().find((job) => job.nodeId === secondNode.nodeId); if (!secondJob) throw new Error("missing job"); await expect(limited.run(secondJob, model(result("second")), second.payloadJson)).rejects.toThrow("budget exhausted"); expect(limited.listJobs().find((job) => job.nodeId === secondNode.nodeId)?.state).toBe("pending"); ledger.close();
  });
  it("does not account invalid model usage", async () => {
    const { ledger, maintenance } = open();
    const source = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main"));
    const node = maintenance.createLeaf([source]);
    if (!node) throw new Error("missing leaf");
    const job = maintenance.listJobs()[0];
    if (!job) throw new Error("missing job");
    const fallback = await maintenance.run(job, model({ ...result("bad"), inputTokens: -1, outputTokens: 1 }), source.payloadJson);
    expect(fallback).toMatchObject({ state: "ready", modelHash: "emergency" });
    expect((fallback as { text: string }).text).toContain("Nonsemantic deterministic excerpt");
    expect((ledger.db.prepare("SELECT count(*) count FROM maintenance_usage").get() as { count: number }).count).toBe(0);
    expect(maintenance.listJobs()[0]?.state).toBe("completed");
    ledger.close();
  });

  it("reclaims an expired lease with a different owner", () => {
    const root = tempRoot("lcm-maintenance-");
    let now = 1_000;
    const ledger = openLedger({ dbPath: path.join(root, "ledger.sqlite"), project: { liveCwd: root } });
    const maintenance = new LcmMaintenance(ledger, { now: () => now });
    const source = ledger.appendRaw(raw(ledger.project.key, "s", "a", "A", "main"));
    const node = maintenance.createLeaf([source]);
    if (!node) throw new Error("missing leaf");
    const job = maintenance.listJobs()[0];
    if (!job) throw new Error("missing job");
    const first = maintenance.claim(job.jobId, "one");
    now += 30_001;
    const second = maintenance.claim(job.jobId, "two");
    expect(second.ownerId).toBe("two");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    ledger.close();
  });

  it("packs a leaf to the input budget and never drops an oversized entry", () => {
    const { ledger, maintenance } = open({ maxLeafEntries: 10, maxInputChars: 2_000 });
    const project = ledger.project.key;
    const stored = Array.from({ length: 10 }, (_, index) =>
      ledger.appendRaw(raw(project, "s", "e" + index, "x".repeat(400), "main")));

    const packed = maintenance.selectLeaf(stored, "main");
    const packedChars = packed.reduce((total, entry) => total + entry.payloadJson.length, 0);
    expect(packed.length).toBeGreaterThan(1);
    expect(packed.length).toBeLessThan(10);
    expect(packedChars).toBeLessThanOrEqual(2_000);
    expect(packedChars + (stored[packed.length]?.payloadJson.length ?? 0)).toBeGreaterThan(2_000);

    const huge = ledger.appendRaw(raw(project, "s", "huge", "y".repeat(5_000), "main"));
    expect(maintenance.selectLeaf([huge], "main")).toHaveLength(1);

    const generous = new LcmMaintenance(ledger, { maxLeafEntries: 3, maxInputChars: 1_000_000 });
    expect(generous.selectLeaf(stored, "main")).toHaveLength(3);
  });

  it("keeps emergency provenance within the UTF-8 byte limit", () => {
    const sources = Array.from({ length: 256 }, (_, index) => ({ sessionId: "s", entryId: `entry-${index}`, revision: 1, payloadHash: "a".repeat(64) }));
    const emergency = emergencyReduce("界".repeat(100_000), 4_096, sources);
    expect(Buffer.byteLength(emergency, "utf8")).toBeLessThanOrEqual(4_096);
    expect(emergency).toContain("Nonsemantic deterministic excerpt");
  });
});
