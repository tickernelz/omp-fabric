import { describe, expect, it } from "vitest";
import {
  entropyReportHash,
  measureEntropy,
  measureEntropyAsync,
  shannonEntropyBits,
  shapeSignature,
  signatureDistance,
  staticFreedomFromSchema,
  type EntropyOperationInput,
  type EntropySurfaceSnapshot,
  type EntropyTraceInput,
} from "../src/entropy/index.js";

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
  failureStage?: string,
): EntropyOperationInput => ({
  ref,
  args,
  outcome,
  ...(failureStage ? { failureStage } : {}),
});

const trace = (
  operations: EntropyOperationInput[],
  taskKey?: string,
): EntropyTraceInput => ({
  operations,
  ...(taskKey ? { taskKey } : {}),
});

const surfaceOf = (actions: Array<{ ref: string; inputSchema: unknown }>): EntropySurfaceSnapshot => ({
  version: 1,
  actions,
});

const convergedTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("omp.read", { path: "src/a.ts", limit: 50 }),
      op("omp.read", { path: "src/b.ts", limit: 50 }),
      op("omp.edit", { path: "src/a.ts" }),
      op("omp.bash", { command: "bun test" }),
    ],
    "converged",
  ),
];

const convergedSurface = (): EntropySurfaceSnapshot =>
  surfaceOf([
    {
      ref: "omp.read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "limit"],
        properties: { path: { type: "string" }, limit: { type: "integer" } },
      },
    },
    {
      ref: "omp.edit",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    {
      ref: "omp.bash",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: { command: { type: "string" } },
      },
    },
  ]);

const wobbleTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("omp.read", { path: "src/x.ts", limit: 50 }),
      op("omp.grep", { path: "src", limit: 20 }),
      op("omp.edit", { path: "src/x.ts" }),
    ],
    "flaky-edit",
  ),
  trace(
    [
      op("omp.grep", { path: "src", limit: 20 }),
      op("omp.read", { path: "src/x.ts", limit: 50 }),
      op("omp.edit", { path: "src/x.ts" }),
    ],
    "flaky-edit",
  ),
  trace(
    [
      op("memory.expand", { session: "s1" }),
      op("memory.expand", { session: "s1" }, "failed", "validate"),
      op("memory.expand", { session: "s1", entryId: "e1" }, "failed", "prepare"),
      op("memory.expand", { session: "s1" }),
      op("fabric.discovery.search", { limit: 5 }),
      op("fabric.workflow.phase", { name: "verify", id: "p1", total: 1 }),
      op("omp.bash", { command: "vitest run" }, "failed", "invoke"),
      op("omp.bash", { command: "vitest run" }),
    ],
    "wobble",
  ),
];

describe("shapeSignature", () => {
  it("canonicalizes key order and value contents", () => {
    expect(shapeSignature({ limit: 50, path: "x" })).toBe("(limit:num,path:str)");
    expect(shapeSignature({ path: "y", limit: 10 })).toBe("(limit:num,path:str)");
  });

  it("tags nested objects to bounded depth", () => {
    expect(shapeSignature({ a: { y: 1, x: "s" } })).toBe("(a:{x:str,y:num})");
  });

  it("signs empty args canonically", () => {
    expect(shapeSignature({})).toBe("()");
  });
});

describe("signatureDistance", () => {
  it("measures normalized retry churn exactly", () => {
    expect(signatureDistance("(session:str)", "(entryId:str,session:str)")).toBe(0.48);
    expect(signatureDistance("(entryId:str,session:str)", "(session:str)")).toBe(0.48);
  });

  it("is zero for identical signatures", () => {
    expect(signatureDistance("(a:str)", "(a:str)")).toBe(0);
  });
});

describe("shannonEntropyBits", () => {
  it("computes exact bits for known distributions", () => {
    expect(shannonEntropyBits([3, 1])).toBe(0.811278);
    expect(shannonEntropyBits([2, 2])).toBe(1);
    expect(shannonEntropyBits([1])).toBe(0);
    expect(shannonEntropyBits([])).toBe(0);
  });
});

describe("staticFreedomFromSchema", () => {
  it("scores free strings above enums above literals", () => {
    expect(staticFreedomFromSchema({ type: "string" })).toBe(1);
    expect(staticFreedomFromSchema({ type: "string", enum: ["a", "b"] })).toBe(0.166667);
    expect(
      staticFreedomFromSchema({
        type: "string",
        enum: Array.from({ length: 64 }, (_, index) => `v${index}`),
      }),
    ).toBe(1);
    expect(staticFreedomFromSchema({ const: "x" })).toBe(0);
    expect(staticFreedomFromSchema({ type: "boolean" })).toBe(0.1);
    expect(staticFreedomFromSchema({ type: "integer" })).toBe(0.5);
  });

  it("taxes optional and open-ended parameters", () => {
    expect(
      staticFreedomFromSchema({
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: { a: { type: "string" } },
      }),
    ).toBe(1);
    expect(
      staticFreedomFromSchema({
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "string" } },
      }),
    ).toBe(1.25);
    expect(
      staticFreedomFromSchema({
        type: "object",
        required: ["a"],
        properties: { a: { type: "string" } },
      }),
    ).toBe(1.5);
  });

  it("scores free-form objects and unions", () => {
    expect(staticFreedomFromSchema({ type: "object" })).toBe(1);
    expect(staticFreedomFromSchema({ type: "object", properties: {} })).toBe(1);
    expect(staticFreedomFromSchema({ anyOf: [{ type: "boolean" }, { type: "string" }] })).toBe(1.1);
  });
});

describe("measureEntropy", () => {
  it("scores a converged corpus exactly", () => {
    const report = measureEntropy({
      traces: convergedTraces(),
      surface: convergedSurface(),
    });
    expect(report.score).toBe(0.21875);
    expect(report.staticFreedom).toBe(3.5);
    expect(report.shapeEntropyBits).toBe(0);
    expect(report.churnRate).toBe(0);
    expect(report.navigationRatio).toBe(0);
    expect(report.flowEntropyBits).toBe(0);
    expect(report.totals.succeeded).toBe(4);
    expect(report.totals.actionOperations).toBe(4);
    expect(report.staticScore).toBe(0.21875);
    expect(report.behavioralScore).toBe(0);
  });

  it("computes every wobble species exactly", () => {
    const report = measureEntropy({ traces: wobbleTraces() });
    const expand = report.refs.find((ref) => ref.ref === "memory.expand");
    expect(expand?.shapeEntropyBits).toBe(0.811278);
    expect(expand?.failureStageEntropyBits).toBe(1);
    expect(expand?.churnRate).toBe(0.48);
    expect(report.churnRate).toBe(0.32);
    expect(report.flowEntropyBits).toBe(0.666667);
    expect(report.navigationRatio).toBe(0.083333);
    expect(report.totals.invocationRejectionsPer1k).toBe(166.666667);
    expect(report.totals.operations).toBe(14);
    expect(report.totals.discoveryOperations).toBe(1);
    expect(report.totals.workflowOperations).toBe(1);
    expect(report.staticScore).toBe(0);
    expect(report.behavioralScore).toBe(report.score);
  });

  it("sorts refs by score descending", () => {
    const report = measureEntropy({ traces: wobbleTraces() });
    expect(report.refs[0]?.ref).toBe("memory.expand");
  });

  it("is deterministic and argument-order invariant", () => {
    const first = measureEntropy({ traces: wobbleTraces() });
    const second = measureEntropy({ traces: wobbleTraces() });
    expect(entropyReportHash(first)).toBe(entropyReportHash(second));
    const shuffled = wobbleTraces().map((source) => ({
      ...source,
      operations: source.operations.map((operation) => ({
        ...operation,
        args: Object.fromEntries(Object.entries(operation.args).reverse()),
      })),
    }));
    expect(entropyReportHash(measureEntropy({ traces: shuffled }))).toBe(
      entropyReportHash(first),
    );
  });

  it("matches the pure meter while yielding throughout a large corpus", async () => {
    const traces = Array.from({ length: 512 }, (_, index) =>
      trace([op("omp.read", { path: `file-${index % 3}` })], `task-${index % 5}`),
    );
    const expected = measureEntropy({ traces });
    let turns = 0;
    let running = true;
    const pulse = (): void => {
      turns += 1;
      if (running) setImmediate(pulse);
    };
    setImmediate(pulse);
    const actual = await measureEntropyAsync({ traces });
    running = false;
    expect(turns).toBeGreaterThanOrEqual(4);
    expect(actual).toEqual(expected);
  });

  it("measures an empty corpus as zero", () => {
    const report = measureEntropy({ traces: [] });
    expect(report.score).toBe(0);
    expect(report.refs).toEqual([]);
    expect(report.totals.operations).toBe(0);
  });
});

describe("per-model attribution", () => {
  it("attributes behavioral terms per producing model with exact scores", () => {
    const wobbleA: EntropyTraceInput = {
      ...trace(
        [op("omp.read", { path: "a" }), op("omp.read", { path: "a", limit: 5 })],
        "ta",
      ),
      model: "p/alpha",
    };
    const stillB: EntropyTraceInput = {
      ...trace(
        [op("omp.edit", { path: "a" }), op("omp.edit", { path: "a" })],
        "tb",
      ),
      model: "p/beta",
    };
    const unstamped = trace([op("omp.bash", { command: "x" })], "tc");
    const report = measureEntropy({ traces: [wobbleA, stillB, unstamped] });
    expect(report.metricVersion).toBe(2);
    expect(report.totals.operations).toBe(5);
    expect(report.byModel.map((entry) => entry.model)).toEqual(["p/alpha", "p/beta"]);
    expect(report.byModel[0]).toMatchObject({
      model: "p/alpha",
      operations: 2,
      actionOperations: 2,
      succeeded: 2,
      behavioralScore: 0.5,
    });
    expect(report.byModel[1]).toMatchObject({
      model: "p/beta",
      operations: 2,
      succeeded: 2,
      behavioralScore: 0,
    });
    // The global report keeps every call: 1 bit of shape over 5 successes.
    expect(report.score).toBe(0.2);
    expect(report.behavioralScore).toBe(0.2);
  });

  it("leaves byModel empty for unstamped corpora", () => {
    const report = measureEntropy({
      traces: [trace([op("omp.read", { path: "a" })], "t")],
    });
    expect(report.byModel).toEqual([]);
  });
});
