import { describe, expect, it } from "vitest";
import {
  FABRIC_EXECUTION_TRACE_KIND,
  FABRIC_EXECUTION_TRACE_VERSION,
  type FabricExecutionTraceV1,
} from "../src/audit/trace.js";
import { formatFailureProgress } from "../src/failure-progress.js";

const trace = (
  outcome: FabricExecutionTraceV1["outcome"],
  operations: FabricExecutionTraceV1["operations"],
): FabricExecutionTraceV1 => ({
  kind: FABRIC_EXECUTION_TRACE_KIND,
  version: FABRIC_EXECUTION_TRACE_VERSION,
  outcome,
  phases: [],
  operations,
  counts: {
    droppedValues: 0,
    truncatedValues: 0,
    redactedValues: 0,
    droppedOperations: 0,
  },
});

describe("formatFailureProgress", () => {
  it("reports completed refs and paths without exposing results", () => {
    const formatted = formatFailureProgress(trace("failed", [
      {
        type: "call",
        sequence: 0,
        ref: "omp.read",
        args: { path: "src/input.ts", offset: 10, limit: 20 },
        outcome: "succeeded",
        result: "sensitive source text",
      },
      {
        type: "call",
        sequence: 1,
        ref: "omp.edit",
        args: { path: "src/output.ts" },
        outcome: "succeeded",
        result: { ok: true },
      },
      {
        type: "call",
        sequence: 2,
        ref: "omp.bash",
        args: { command: "npm test -- --runInBand" },
        outcome: "failed",
        error: "tests failed",
      },
    ]));

    expect(formatted).toContain("omp.read(src/input.ts); omp.edit(src/output.ts)");
    expect(formatted).toContain("inspect before repeating mutations");
    expect(formatted).not.toContain("sensitive source text");
    expect(formatted).not.toContain("npm test");
  });

  it("stays absent for successful runs or failures with no completed calls", () => {
    expect(formatFailureProgress(trace("succeeded", []))).toBeUndefined();
    expect(formatFailureProgress(trace("failed", [{
      type: "call",
      sequence: 0,
      ref: "omp.bash",
      args: {},
      outcome: "failed",
    }]))).toBeUndefined();
  });

  it("bounds long call lists and paths", () => {
    const operations: FabricExecutionTraceV1["operations"] = Array.from(
      { length: 12 },
      (_, sequence) => ({
        type: "call",
        sequence,
        ref: "omp.edit",
        args: { path: `src/${"nested/".repeat(30)}file-${sequence}.ts` },
        outcome: "succeeded",
      }),
    );
    const formatted = formatFailureProgress(trace("failed", operations));
    expect(formatted).toContain("+4 more");
    expect(formatted!.length).toBeLessThan(1_200);
  });
});
