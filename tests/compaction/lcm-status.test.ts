import { describe, expect, it } from "vitest";
import { lcmStatusLabel, lcmStatusLine, reconcileLcmState } from "../../src/compaction/lcm-status.js";
import type { LcmReport } from "../../src/compaction/lcm-runtime.js";

const report = (overrides: Partial<LcmReport> = {}): LcmReport => {
  const ledgerState = overrides.ledgerState ?? "healthy";
  const degraded = overrides.degraded;
  return {
    projectKey: "v1:project",
    sessionId: "session-1",
    ledgerState,
    degraded,
    reconciliation: undefined,
    summaryModel: "anthropic/claude-haiku",
    rawEntries: 5_392,
    sessionEntries: 5_368,
    modelNodes: 12,
    emergencyNodes: 3,
    pendingNodes: 0,
    pendingJobs: 0,
    upgradableNodes: 1,
    usage: { calls: 4, inputTokens: 100, outputTokens: 20, cost: 0.031, wallMs: 55_000 },
    budget: { calls: Number.POSITIVE_INFINITY, sessionCalls: 16, wallMs: 7_200_000 },
    ...overrides,
    state: reconcileLcmState(ledgerState, degraded),
  };
};

describe("LCM status", () => {
  it("never prints healthy beside a fault while keeping the ledger fact readable", () => {
    const faulted = report({ degraded: "LCM maintenance left 1 job failed" });

    expect(faulted.state).toBe("degraded");
    expect(faulted.ledgerState).toBe("healthy");
    expect(lcmStatusLabel(faulted)).toBe("degraded (ledger healthy)");
  });

  it("keeps one label when the ledger itself is the fault", () => {
    const both = report({ ledgerState: "degraded", degraded: "ledger is degraded" });

    expect(lcmStatusLabel(both)).toBe("degraded");
  });

  it("summarises a healthy ledger without a parenthetical", () => {
    const healthy = report();

    expect(lcmStatusLabel(healthy)).toBe("healthy");
    expect(lcmStatusLine(healthy)).toContain("5392");
  });

  it("never prints a bare healthy state on the status line while a fault stands", () => {
    const faulted = report({ degraded: "LCM maintenance left 1 job failed" });
    const line = lcmStatusLine(faulted);

    expect(line).toContain("degraded (ledger healthy)");
    expect(line).toContain("fault: LCM maintenance left 1 job failed");
    expect(line).not.toMatch(/compaction: lcm \u00b7 healthy/);
  });
});
