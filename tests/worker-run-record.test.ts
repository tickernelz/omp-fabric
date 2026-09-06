import { describe, expect, it } from "vitest";
import { applyUsage, extractUsageDelta } from "../src/worker/run-record.js";
import type { AgentRunRecord } from "../src/agents/types.js";

const baseRecord = (): AgentRunRecord => ({
  id: "id",
  name: "name",
  task: "task",
  status: "running",
  runner: "omp",
  transport: "process",
  cwd: "/tmp",
  startedAt: 0,
  updatedAt: 0,
  turns: 0,
  toolCalls: 0,
  text: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  logFile: "/tmp/log",
});

describe("worker run-record usage", () => {
  it("extractUsageDelta returns per-message usage without mutating the record", () => {
    const record = baseRecord();
    const delta = extractUsageDelta({
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 42 } },
    });
    expect(delta).toEqual({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 42 });
    expect(record.usage.input).toBe(0);
  });

  it("extractUsageDelta treats a numeric cost as already in total units", () => {
    const delta = extractUsageDelta({ usage: { input: 1, output: 2, cost: 7 } });
    expect(delta).toMatchObject({ input: 1, output: 2, cost: 7 });
  });

  it("extractUsageDelta returns undefined for a usage-free message", () => {
    expect(extractUsageDelta({ content: "text" })).toBeUndefined();
    expect(extractUsageDelta({ usage: null })).toBeUndefined();
  });

  it("applyUsage and extractUsageDelta agree on the same message", () => {
    const record = baseRecord();
    const delta = extractUsageDelta({
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 25 } },
    })!;
    applyUsage(record, {
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 25 } },
    });
    expect(record.usage.input).toBe(delta.input);
    expect(record.usage.output).toBe(delta.output);
    expect(record.usage.cacheRead).toBe(delta.cacheRead);
    expect(record.usage.cacheWrite).toBe(delta.cacheWrite);
    expect(record.usage.cost).toBe(delta.cost);
  });

  it("extractUsageDelta on cumulative Claude frames produces monotonically increasing attribution", () => {
    const first = extractUsageDelta({
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
    })!;
    const second = extractUsageDelta({
      usage: { input: 25, output: 12, cacheRead: 5, cacheWrite: 3 },
    })!;
    const delta = {
      input: second.input - first.input,
      output: second.output - first.output,
      cacheRead: second.cacheRead - first.cacheRead,
      cacheWrite: second.cacheWrite - first.cacheWrite,
    };
    expect(delta.input).toBe(15);
    expect(delta.output).toBe(7);
    expect(delta.cacheRead).toBe(3);
    expect(delta.cacheWrite).toBe(2);
  });
});
