import { describe, expect, it } from "vitest";
import {
  runEntropyTrial,
  schemaDigest,
  type CompiledSurfaceFile,
  type EntropySurfaceSnapshot,
} from "../src/entropy/index.js";

const renderSchema = {
  type: "object",
  properties: { format: { type: "string" } },
  required: ["format"],
  additionalProperties: false,
};

const bashSchema = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
  additionalProperties: false,
};

const live = (): EntropySurfaceSnapshot => ({
  version: 1,
  actions: [
    { ref: "mcp.report.render", inputSchema: renderSchema },
    { ref: "omp.bash", inputSchema: bashSchema },
  ],
});

const artifact = (): CompiledSurfaceFile => ({
  version: 1,
  metricVersion: 2,
  actions: [
    {
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        properties: { format: { type: "string", enum: ["pdf", "html"] } },
        required: ["format"],
        additionalProperties: false,
      },
      baseSchemaDigest: schemaDigest(renderSchema),
    },
  ],
  quarantined: [{ ref: "omp.bash", baseSchemaDigest: schemaDigest(bashSchema) }],
  applied: [],
  gate: { passed: true, beforeScore: 0.3, afterScore: 0.2, reasons: [] },
  evidenceDigest: "test",
});

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
  failureStage?: string,
) => ({ ref, args, outcome, ...(failureStage ? { failureStage } : {}) });

const trace = (operations: ReturnType<typeof op>[]) => ({ operations });

describe("runEntropyTrial", () => {
  it("classifies every counterfactual divergence", () => {
    const report = runEntropyTrial({
      traces: [
        trace([
          op("mcp.report.render", { format: "pdf" }),
          op("mcp.report.render", { format: "docx" }),
          op("mcp.report.render", { format: "weird" }, "failed", "effect"),
          op("omp.bash", { command: "ls" }, "failed", "effect"),
          op("omp.bash", { command: "bun test" }),
          op("omp.bash", { command: 42 }, "failed", "validate"),
          op("omp.read", { path: "a.ts" }),
          op("fabric.workflow", {}),
        ]),
      ],
      live: live(),
      artifact: artifact(),
    });
    expect(report.totals).toEqual({
      operations: 6,
      bothAccept: 1,
      bothReject: 1,
      tighteningCost: 1,
      typedFailureWin: 1,
      quarantineWin: 1,
      quarantineCost: 1,
    });
    expect(report.verdict).toBe("costly");
    expect(report.delta).toBeLessThan(0);
    expect(report.divergences).toEqual([
      { ref: "mcp.report.render", trialClass: "tightening-cost", count: 1 },
      { ref: "mcp.report.render", trialClass: "typed-failure-win", count: 1 },
      { ref: "omp.bash", trialClass: "quarantine-cost", count: 1 },
      { ref: "omp.bash", trialClass: "quarantine-win", count: 1 },
    ]);
  });

  it("stale entries fall back to the declared surface and cost nothing", () => {
    const stale: CompiledSurfaceFile = {
      ...artifact(),
      actions: [
        {
          ref: "mcp.report.render",
          inputSchema: {
            type: "object",
            properties: { format: { type: "string", enum: ["pdf"] } },
            required: ["format"],
            additionalProperties: false,
          },
          baseSchemaDigest: schemaDigest({ type: "object" }),
        },
      ],
      quarantined: [{ ref: "omp.bash", baseSchemaDigest: schemaDigest({ type: "object" }) }],
    };
    const report = runEntropyTrial({
      traces: [
        trace([
          op("mcp.report.render", { format: "docx" }),
          op("omp.bash", { command: "bun test" }),
        ]),
      ],
      live: live(),
      artifact: stale,
    });
    expect(report.totals).toEqual({
      operations: 2,
      bothAccept: 2,
      bothReject: 0,
      tighteningCost: 0,
      typedFailureWin: 0,
      quarantineWin: 0,
      quarantineCost: 0,
    });
    expect(report.verdict).toBe("clean");
    expect(report.delta).toBe(0);
  });

  it("reports no evidence without a meaningful artifact", () => {
    const traces = [trace([op("mcp.report.render", { format: "pdf" })])];
    expect(runEntropyTrial({ traces, live: live() }).verdict).toBe("no-evidence");
    const empty: CompiledSurfaceFile = {
      ...artifact(),
      actions: [],
      quarantined: [],
    };
    expect(runEntropyTrial({ traces, live: live(), artifact: empty }).verdict).toBe("no-evidence");
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      traces: [
        trace([
          op("mcp.report.render", { format: "docx" }),
          op("omp.bash", { command: "ls" }, "failed", "effect"),
        ]),
      ],
      live: live(),
      artifact: artifact(),
    };
    expect(JSON.stringify(runEntropyTrial(input))).toBe(JSON.stringify(runEntropyTrial(input)));
  });

  it("replays audited refs verbatim and counts unknown outcomes as costs", () => {
    const traces = [
      trace([
        op("mcp.report.render", {}),
        op("mcp.report.render", {}),
        op("mcp.report.render", {}, "failed", "invoke"),
      ]),
    ];
    const auditCalls = [
      { ref: "mcp.report.render", args: { format: "pdf" } },
      { ref: "mcp.report.render", args: { format: "docx" } },
      { ref: "mcp.report.render", args: { format: "html" } },
    ];
    const report = runEntropyTrial({ traces, live: live(), artifact: artifact(), auditCalls });
    expect(report.totals).toEqual({
      operations: 3,
      bothAccept: 2,
      bothReject: 0,
      tighteningCost: 1,
      typedFailureWin: 0,
      quarantineWin: 0,
      quarantineCost: 0,
    });
    expect(report.divergences).toEqual([
      { ref: "mcp.report.render", trialClass: "tightening-cost", count: 1 },
    ]);
    expect(report.verdict).toBe("costly");
  });
});
