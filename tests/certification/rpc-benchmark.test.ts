import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error Certification helpers are dependency-free JavaScript used directly by Node.
import { benchmarkGate, LfJsonlParser, pairedOrders, summarizeBenchmark } from "../../scripts/certification/rpc-lib.mjs";

describe("strict LF JSONL parser", () => {
  it("preserves Unicode line separators and handles split UTF-8 chunks", () => {
    const records: unknown[] = [];
    const parser = new LfJsonlParser((record: unknown) => records.push(record));
    const payload = Buffer.from('{"text":"left middle right"}\n{"ok":true}\r\n', "utf8");
    parser.push(payload.subarray(0, 13));
    parser.push(payload.subarray(13, 21));
    parser.push(payload.subarray(21));
    parser.end();
    expect(records).toEqual([
      { text: "left middle right" },
      { ok: true },
    ]);
  });

  it("flushes a final record without LF and rejects invalid JSON", () => {
    const records: unknown[] = [];
    const parser = new LfJsonlParser((record: unknown) => records.push(record));
    parser.push('{"final":1}');
    parser.end();
    expect(records).toEqual([{ final: 1 }]);
    const invalid = new LfJsonlParser(() => {});
    expect(() => invalid.push("not-json\n")).toThrow();
  });
});

describe("real benchmark safety gate", () => {
  it("is disabled by default and identifies every required opt-in", () => {
    const gate = benchmarkGate({});
    expect(gate.enabled).toBe(false);
    expect(gate.reasons).toContain("OMP_FABRIC_REAL_RESUME must equal 1");
    expect(gate.config.repeats).toBe(0);
    expect(gate.config.maxUsd).toBe(0);
  });

  it("enables only with opt-in, model/provider, credential, repeats, and budget", () => {
    const gate = benchmarkGate({
      OMP_FABRIC_REAL_RESUME: "1",
      OMP_FABRIC_BENCH_MODEL: "model-id",
      OMP_FABRIC_BENCH_PROVIDER: "provider-id",
      OMP_FABRIC_BENCH_KEY_ENV: "TEST_MODEL_KEY",
      TEST_MODEL_KEY: "not-reported",
      OMP_FABRIC_BENCH_REPEATS: "2",
      OMP_FABRIC_BENCH_MAX_USD: "1.25",
    });
    expect(gate).toMatchObject({ enabled: true, config: { repeats: 2, maxUsd: 1.25 } });
    expect(JSON.stringify(gate)).not.toContain("not-reported");
  });

  it("default benchmark command exits successfully with a skip report", () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("OMP_FABRIC_BENCH") || key === "OMP_FABRIC_REAL_RESUME") delete env[key];
    }
    const result = spawnSync(process.execPath, [path.resolve("scripts/benchmark-real-resume.mjs")], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Real OMP resume benchmark: SKIP");
    expect(result.stdout).toContain('"skipped": true');
  });
});

describe("benchmark report", () => {
  it("randomizes paired order deterministically and reports confidence and paired rates", () => {
    expect(pairedOrders(4, "seed")).toEqual(pairedOrders(4, "seed"));
    const runs = [
      { repeat: 1, variant: "baseline", oracle: { passed: false }, tokens: 10, costUsd: 0.1, toolCalls: 1, recallCalls: 0, wallMs: 10 },
      { repeat: 1, variant: "fabric", oracle: { passed: true }, tokens: 8, costUsd: 0.08, toolCalls: 2, recallCalls: 1, wallMs: 9 },
      { repeat: 2, variant: "baseline", oracle: { passed: true }, tokens: 9, costUsd: 0.09, toolCalls: 1, recallCalls: 0, wallMs: 8 },
      { repeat: 2, variant: "fabric", oracle: { passed: true }, tokens: 7, costUsd: 0.07, toolCalls: 1, recallCalls: 0, wallMs: 7 },
    ];
    const report = summarizeBenchmark(runs, [["fabric", "baseline"], ["baseline", "fabric"]], 1);
    expect(report.variants.fabric.passRate).toBe(1);
    expect(report.variants.fabric.passRate95.low).toBeGreaterThan(0);
    expect(report.pairedRates.baseline_vs_fabric).toEqual({ leftWins: 0, rightWins: 1, ties: 1 });
    expect(report.budget.observedUsd).toBeCloseTo(0.34);
  });
});
