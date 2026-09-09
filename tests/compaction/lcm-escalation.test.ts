import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LcmMaintenance } from "../../src/compaction/lcm-maintenance.js";
import { buildLcmPrompt, emergencyReduce, type LcmModelResult, type LcmSummarizer } from "../../src/compaction/lcm-model.js";
import { LcmMemoryAdapter, type LcmMemoryLedger, type LcmSummaryReader } from "../../src/memory/lcm-adapter.js";
import { canonicalLcmPayload } from "../../src/storage/lcm-ledger.js";
import { openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

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

const usage = (text: string): LcmModelResult => ({ text, inputTokens: 1, outputTokens: 1, cost: 0, wallMs: 1, modelHash: "test" });

const scripted = (replies: readonly string[]): { model: LcmSummarizer; prompts: string[] } => {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    model: {
      modelHash: "test",
      generate: async (request) => {
        prompts.push(request.prompt);
        const reply = replies[Math.min(call, replies.length - 1)] ?? "";
        call += 1;
        return usage(reply);
      },
    },
  };
};

const open = (options: ConstructorParameters<typeof LcmMaintenance>[1] = {}) => {
  const root = tempRoot("lcm-escalation-");
  const ledger = openLedger({ dbPath: path.join(root, "db.sqlite"), project: { liveCwd: root } });
  return { ledger, maintenance: new LcmMaintenance(ledger, options) };
};

const leafJob = (ledger: ReturnType<typeof open>["ledger"], maintenance: LcmMaintenance, entryId: string, text: string) => {
  const source = ledger.appendRaw(raw(ledger.project.key, "s", entryId, text));
  const node = maintenance.createLeaf([source]);
  if (!node) throw new Error("missing leaf");
  const job = maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
  if (!job) throw new Error("missing job");
  return { source, node, job };
};

afterEach(releaseTemp);

describe("LCM escalation ladder", () => {
  it("escalates to the bullet level when the model returns more than it was given", async () => {
    const { ledger, maintenance } = open();
    const evidence = "Decision: keep the shrink invariant. ".repeat(20);
    const { job } = leafJob(ledger, maintenance, "inflate-once", "inflate once");
    const { model, prompts } = scripted([evidence + "x".repeat(evidence.length), "bulleted summary"]);

    const settled = await maintenance.run(job, model, evidence);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Return concise plain text");
    expect(prompts[1]).toContain("terse bullet points");
    expect(settled.text).toBe("bulleted summary");
    expect(settled.modelHash).toBe("test");
    ledger.close();
  });

  it("halves the declared byte target between the two model levels", async () => {
    const { ledger, maintenance } = open({ maxOutputChars: 2_048 });
    const evidence = "Constraint: the summary target halves at level two. ".repeat(100);
    const { job } = leafJob(ledger, maintenance, "targets", "targets");
    const { model, prompts } = scripted([evidence + evidence, "short"]);

    await maintenance.run(job, model, evidence);

    expect(prompts[0]).toContain("shorter than 2048 UTF-8 bytes");
    expect(prompts[1]).toContain("shorter than 1024 UTF-8 bytes");
    ledger.close();
  });

  it("lands on the deterministic level when the model inflates twice", async () => {
    const { ledger, maintenance } = open();
    const evidence = "Unresolved: prove that two inflating levels still converge. ".repeat(30);
    const { job } = leafJob(ledger, maintenance, "inflate-twice", "inflate twice");
    const { model, prompts } = scripted([evidence + "a", evidence + "bb"]);

    const settled = await maintenance.run(job, model, evidence);

    expect(prompts).toHaveLength(2);
    expect(settled.modelHash).toBe("emergency");
    expect(bytes(settled.text ?? "")).toBeLessThan(bytes(evidence));
    expect(settled.text).toContain("Nonsemantic deterministic excerpt");
    expect(maintenance.listJobs().find((item) => item.jobId === job.jobId)?.state).toBe("completed");
    ledger.close();
  });

  it("charges every model call it made, including the rejected one", async () => {
    const { ledger, maintenance } = open();
    const evidence = "Budget: a rejected call still costs money. ".repeat(20);
    const { job } = leafJob(ledger, maintenance, "charged", "charged");
    const { model } = scripted([evidence + "!", "accepted summary"]);

    await maintenance.run(job, model, evidence);

    const row = ledger.db.prepare("SELECT COALESCE(SUM(calls),0) calls FROM maintenance_usage WHERE project_key=?").get(ledger.project.key) as { calls: number };
    expect(row.calls).toBe(2);
    ledger.close();
  });

  it("degrades to the deterministic level when the budget runs out mid-ladder", async () => {
    const { ledger } = open();
    const maintenance = new LcmMaintenance(ledger, { budget: { sessionCalls: 1 } });
    const evidence = "Budget: one call only, then fall through. ".repeat(20);
    const { job } = leafJob(ledger, maintenance, "exhausted", "exhausted");
    const { model, prompts } = scripted([evidence + "!", "never asked"]);

    const settled = await maintenance.run(job, model, evidence);

    expect(prompts).toHaveLength(1);
    expect(settled.state).toBe("ready");
    expect(settled.modelHash).toBe("emergency");
    expect(maintenance.listJobs().find((item) => item.jobId === job.jobId)?.state).toBe("completed");
    ledger.close();
  });

  it("rejects a non-shrinking summary at the write gate", async () => {
    const { ledger, maintenance } = open();
    const evidence = "Gate: complete refuses to grow the context. ".repeat(10);
    const { job } = leafJob(ledger, maintenance, "gate", "gate");
    const claimed = maintenance.claim(job.jobId);

    expect(() => maintenance.complete(claimed, usage(evidence), bytes(evidence))).toThrow("summary does not shrink its input");
    expect(() => maintenance.complete(claimed, usage(evidence + "!"), bytes(evidence))).toThrow("summary does not shrink its input");
    expect(maintenance.getNode(job.nodeId)?.state).toBe("pending");

    const accepted = maintenance.complete(claimed, usage("short"), bytes(evidence));
    expect(accepted.state).toBe("ready");
    expect(accepted.text).toBe("short");
    ledger.close();
  });

  it("shrinks every input, far below and far above the output bound", () => {
    const unit = "Ünïcödé decision 界; identifier 43117. ";
    const sizes = [1, 2, 3, 7, 15, 63, 64, 127, 128, 129, 255, 1_023, 4_095, 4_096, 4_097, 20_000];
    const sources = [{ sessionId: "s", entryId: "e1", revision: 1, payloadHash: "a".repeat(64) }];
    for (const size of sizes) {
      const input = unit.repeat(Math.ceil(size / unit.length) + 1).slice(0, size);
      for (const limit of [128, 1_024, 4_096]) {
        const reduced = emergencyReduce(input, limit, sources);
        expect(bytes(reduced)).toBeLessThan(bytes(input));
        expect(bytes(reduced)).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("emits raw addresses the memory adapter accepts", () => {
    const { ledger, maintenance } = open();
    const evidence = "Provenance: the excerpt must stay expandable. ".repeat(40);
    const { source } = leafJob(ledger, maintenance, "addressed", evidence);
    const reduced = emergencyReduce(evidence, 4_096, [source]);

    const line = reduced.split("\n").find((entry) => entry.startsWith("sources: ")) ?? "";
    const address = line.slice("sources: ".length).split(", ")[0] ?? "";
    expect(address).toBe(`lcm.raw:${source.sessionId}:${source.entryId}:${source.revision}`);

    const reader: LcmSummaryReader = { listNodes: () => [], getNode: () => undefined };
    const reads: LcmMemoryLedger = {
      projectKey: ledger.project.key,
      readRaw: () => [],
      readRawPage: () => [],
      readRawEntry: (sessionId, entryId, revision) => ledger.readRawEntry(ledger.project.key, sessionId, entryId, revision),
      searchRaw: () => ({ rows: [], total: 0, scanned: 0, complete: true }),
    };
    const adapter = new LcmMemoryAdapter({ ledger: reads, summaries: reader });

    const expanded = adapter.expand({ session: address, branches: "all" }) as { entries: unknown[]; error?: { code: string } };
    expect(expanded.error).toBeUndefined();
    expect(expanded.entries).toHaveLength(1);

    const legacy = `${source.sessionId}/${source.entryId}@${source.revision}:${source.payloadHash}`;
    const rejected = adapter.expand({ session: legacy, branches: "all" }) as { error?: { code: string } };
    expect(rejected.error?.code).toBe("invalid_address");
    ledger.close();
  });

  it("marks the evidence it had to clip so the model is not told a fragment is whole", () => {
    const evidence = "y".repeat(10_000);
    const clipped = buildLcmPrompt("leaf", evidence, 1_024);
    const whole = buildLcmPrompt("leaf", "short evidence", 1_024);

    expect(bytes(clipped)).toBeLessThanOrEqual(1_024);
    expect(clipped).toContain("evidence truncated");
    expect(clipped).toContain("of 10000 bytes omitted");
    expect(clipped).toContain("fragment, not the whole range");
    expect(whole).not.toContain("evidence truncated");
    expect(whole).toContain("short evidence");
  });
});
