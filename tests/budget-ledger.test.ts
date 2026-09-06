import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeBudgetState,
  appendBudgetLedger,
  clearOwnedBudgetEnv,
  initBudgetLedger,
  readBudgetLedger,
  readBudgetLedgerDetailed,
} from "../src/agents/budget-ledger.js";

const temporaryFiles: string[] = [];

afterEach(() => {
  clearOwnedBudgetEnv();
  for (const file of temporaryFiles.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

describe("budget ledger", () => {
  it("reports no active budget by default", () => {
    expect(activeBudgetState()).toBeUndefined();
  });

  it("initializes a ledger and round-trips through the environment", () => {
    const state = initBudgetLedger(0.25);
    temporaryFiles.push(state.file);
    expect(state.budget).toBe(0.25);
    expect(fs.existsSync(state.file)).toBe(true);
    const inherited = activeBudgetState();
    expect(inherited).toBeDefined();
    expect(inherited?.budget).toBe(0.25);
    expect(inherited?.file).toBe(state.file);
    expect(inherited?.id).toBe(state.id);
  });

  it("treats a non-positive budget as inactive", () => {
    process.env.OMP_FABRIC_BUDGET = "0";
    process.env.OMP_FABRIC_BUDGET_FILE = "/tmp/ignored";
    process.env.OMP_FABRIC_BUDGET_ID = "x";
    try {
      expect(activeBudgetState()).toBeUndefined();
    } finally {
      clearOwnedBudgetEnv();
    }
  });

  it("sums appended entries and tolerates malformed lines", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.06,
      tokens: 30,
      ts: 1,
    });
    appendBudgetLedger(state.file, {
      id: "b",
      depth: 2,
      cost: 0.04,
      tokens: 70,
      ts: 2,
    });
    fs.appendFileSync(state.file, "not json\n\n");
    const summary = readBudgetLedger(state.file);
    expect(summary.cost).toBeCloseTo(0.1);
    expect(summary.tokens).toBe(100);
  });

  it("attributes entries by runner and actor for token telemetry", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.05,
      tokens: 30,
      ts: 1,
      runner: "omp",
    });
    appendBudgetLedger(state.file, {
      id: "b",
      depth: 2,
      cost: 0.03,
      tokens: 20,
      ts: 2,
      runner: "claude",
      actorId: "actor-1",
      actorName: "reviewer",
    });
    appendBudgetLedger(state.file, {
      id: "c",
      depth: 1,
      cost: 0.02,
      tokens: 10,
      ts: 3,
      runner: "omp",
      actorId: "actor-1",
      actorName: "reviewer",
    });
    const detail = readBudgetLedgerDetailed(state.file);
    expect(detail.cost).toBeCloseTo(0.1);
    expect(detail.tokens).toBe(60);
    expect(detail.entries).toHaveLength(3);
    expect(detail.byRunner.omp).toEqual({ cost: expect.closeTo(0.07), tokens: 40 });
    expect(detail.byRunner.claude).toEqual({ cost: expect.closeTo(0.03), tokens: 20 });
    expect(detail.byActor["actor-1"]).toEqual({ cost: expect.closeTo(0.05), tokens: 30 });
  });

  it("keeps readBudgetLedger backward-compatible with per-run totals", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    appendBudgetLedger(state.file, {
      id: "a",
      depth: 1,
      cost: 0.05,
      tokens: 30,
      ts: 1,
      runner: "omp",
      actorId: "actor-1",
    });
    const summary = readBudgetLedger(state.file);
    expect(summary.cost).toBeCloseTo(0.05);
    expect(summary.tokens).toBe(30);
  });

  it("skips malformed attributed entries without failing the rollup", () => {
    const state = initBudgetLedger(1);
    temporaryFiles.push(state.file);
    fs.appendFileSync(state.file, JSON.stringify({ id: 1, cost: "bad", tokens: 2 }) + "\n");
    appendBudgetLedger(state.file, {
      id: "ok",
      depth: 1,
      cost: 0.01,
      tokens: 5,
      ts: 1,
      runner: "omp",
    });
    const detail = readBudgetLedgerDetailed(state.file);
    expect(detail.entries).toHaveLength(1);
    expect(detail.entries[0]!.id).toBe("ok");
    expect(detail.byRunner.omp).toEqual({ cost: expect.closeTo(0.01), tokens: 5 });
  });

  it("returns zero for a missing ledger file", () => {
    expect(readBudgetLedger(path.join(os.tmpdir(), "omp-fabric-missing-cost.jsonl"))).toEqual({
      cost: 0,
      tokens: 0,
    });
  });
});
