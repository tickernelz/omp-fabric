import { describe, expect, it } from "vitest";
import {
  applyProposalsToSurface,
  evaluateGate,
  measureEntropy,
  proposeEntropyReductions,
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

const ratchetTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "html" }),
    ],
    "ratchet",
  ),
  trace(
    [
      op("mcp.flaky.run", { mode: "fast" }, "failed", "validate"),
      op("mcp.flaky.run", { mode: "slow" }, "failed", "invoke"),
      op("mcp.flaky.run", { mode: "fast" }, "failed", "validate"),
      op("mcp.flaky.run", { mode: "fast" }, "failed", "invoke"),
    ],
    "ratchet",
  ),
  trace(
    [
      op("memory.expand", { session: "s1" }),
      ...["s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((session) =>
        op("memory.expand", { session }),
      ),
    ],
    "ratchet",
  ),
];

const ratchetSurface = (): EntropySurfaceSnapshot =>
  surfaceOf([
    {
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { type: "string", enum: ["docx", "html", "pdf", "web"] } },
      },
    },
    {
      ref: "mcp.flaky.run",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { type: "string" } },
      },
    },
    {
      ref: "memory.expand",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["session"],
        properties: { session: { type: "string" } },
      },
    },
  ]);

const ratchetRepairs = () => [
  { kind: "keyAlias" as const, ref: "memory.expand", from: "sessionId", to: "session" },
];

const structureTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("omp.read", { path: "a" }),
      op("omp.grep", { path: "." }),
      op("omp.edit", { path: "a" }),
    ],
    "loop",
  ),
  trace(
    [
      op("omp.read", { path: "b" }),
      op("omp.grep", { path: "." }),
      op("omp.edit", { path: "b" }),
    ],
    "loop",
  ),
  trace(
    [
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
    ],
    "structure",
  ),
];

const compiledRatchet = () => {
  const before = measureEntropy({
    traces: ratchetTraces(),
    surface: ratchetSurface(),
    repairs: ratchetRepairs(),
  });
  const proposals = proposeEntropyReductions({
    report: before,
    traces: ratchetTraces(),
    surface: ratchetSurface(),
    repairs: ratchetRepairs(),
  });
  const compiled = applyProposalsToSurface(ratchetSurface(), proposals);
  return { before, proposals, compiled };
};

describe("proposeEntropyReductions", () => {
  it("proposes only mechanically supported reductions for the ratchet corpus", () => {
    const { proposals } = compiledRatchet();
    expect(proposals).toHaveLength(2);
    expect(proposals.find((proposal) => proposal.kind === "enum-tighten")).toMatchObject({
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
    expect(
      proposals.find((proposal) => proposal.kind === "noise-quarantine"),
    ).toMatchObject({
      ref: "mcp.flaky.run",
      calls: 4,
      succeeded: 0,
      failed: 4,
      failureStageEntropyBits: 1,
    });
  });

  it("converges while retaining repair rows as compatibility aliases", () => {
    const { compiled } = compiledRatchet();
    const after = measureEntropy({
      traces: ratchetTraces(),
      surface: compiled,
      repairs: ratchetRepairs(),
    });
    expect(
      proposeEntropyReductions({
        report: after,
        traces: ratchetTraces(),
        surface: compiled,
        repairs: ratchetRepairs(),
      }),
    ).toEqual([]);
  });

  it("keeps a gate-proven enum as a floor: pre-birth observations never widen", () => {
    const incumbent = surfaceOf([
      {
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          properties: { format: { type: "string", enum: ["pdf", "html"] } },
          required: ["format"],
          additionalProperties: false,
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 5 }, () => op("mcp.render", { format: "pdf" })),
        op("mcp.render", { format: "html" }),
        op("mcp.render", { format: "html" }),
        op("mcp.render", { format: "docx" }),
      ]),
    ];
    const valueObservations = [
      ...Array.from({ length: 5 }, () => ({ ref: "mcp.render", key: "format", value: "pdf" })),
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "docx" },
    ];
    const report = measureEntropy({ traces, surface: incumbent });
    expect(
      proposeEntropyReductions({ report, traces, surface: incumbent, valueObservations }),
    ).toEqual([]);
  });

  it("still tightens beneath a floor when incumbent values age out", () => {
    const incumbent = surfaceOf([
      {
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          properties: { format: { type: "string", enum: ["pdf", "html", "docx"] } },
          required: ["format"],
          additionalProperties: false,
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 6 }, () => op("mcp.render", { format: "pdf" })),
        op("mcp.render", { format: "html" }),
        op("mcp.render", { format: "html" }),
      ]),
    ];
    const valueObservations = [
      ...Array.from({ length: 6 }, () => ({ ref: "mcp.render", key: "format", value: "pdf" })),
      { ref: "mcp.render", key: "format", value: "html" },
      { ref: "mcp.render", key: "format", value: "html" },
    ];
    const report = measureEntropy({ traces, surface: incumbent });
    expect(
      proposeEntropyReductions({ report, traces, surface: incumbent, valueObservations }),
    ).toEqual([
      expect.objectContaining({
        kind: "enum-tighten",
        ref: "mcp.render",
        key: "format",
        values: ["pdf", "html"],
      }),
    ]);
  });

  it("never proposes enum-tighten for a declared boolean parameter", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.flags.set",
        inputSchema: {
          type: "object",
          properties: { force: { type: "boolean" } },
          required: ["force"],
          additionalProperties: false,
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 5 }, () => op("mcp.flags.set", { force: true })),
        ...Array.from({ length: 3 }, () => op("mcp.flags.set", { force: false })),
      ]),
    ];
    const valueObservations = [
      ...Array.from({ length: 5 }, () => ({ ref: "mcp.flags.set", key: "force", value: true })),
      ...Array.from({ length: 3 }, () => ({ ref: "mcp.flags.set", key: "force", value: false })),
    ];
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces, surface }),
        traces,
        surface,
        valueObservations,
      }),
    ).toEqual([]);
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces }),
        traces,
        valueObservations,
      }),
    ).toEqual([]);
  });

  it("applies proposals without mutating the input surface", () => {
    const surface = ratchetSurface();
    const snapshot = JSON.stringify(surface);
    const before = measureEntropy({
      traces: ratchetTraces(),
      surface: ratchetSurface(),
      repairs: ratchetRepairs(),
    });
    const proposals = proposeEntropyReductions({
      report: before,
      traces: ratchetTraces(),
      surface: ratchetSurface(),
      repairs: ratchetRepairs(),
    });
    const compiled = applyProposalsToSurface(surface, proposals);
    expect(JSON.stringify(surface)).toBe(snapshot);
    expect(compiled.actions.map((action) => action.ref)).toEqual([
      "mcp.report.render",
      "memory.expand",
    ]);
    const render = compiled.actions.find((action) => action.ref === "mcp.report.render");
    expect(
      (render?.inputSchema as { properties: { format: { enum?: unknown } } }).properties
        .format.enum,
    ).toEqual(["pdf", "html"]);
    const expand = compiled.actions.find((action) => action.ref === "memory.expand");
    const expandSchema = expand?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(expandSchema.properties.session).toBeDefined();
    expect(expandSchema.properties.sessionId).toBeUndefined();
    expect(expandSchema.required).toEqual(["session"]);
  });

  it("does not mistake repeated OMP primitives for a composite action", () => {
    const report = measureEntropy({ traces: structureTraces() });
    const proposals = proposeEntropyReductions({
      report,
      traces: structureTraces(),
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "overload-split",
      ref: "mcp.store.put",
      shapeEntropyBits: 1,
      clusters: [
        { keys: ["key", "value"], calls: 3 },
        { keys: ["limit", "prefix"], calls: 3 },
      ],
    });
  });

  it("requires a high-level sequence to recur in independent executions", () => {
    const workflow = [
      op("memory.recall", { query: "needle" }),
      op("memory.expand", { session: "s1" }),
      op("state.get", { key: "answer" }),
    ];
    const repeated = [trace(workflow), trace(workflow), trace(workflow)];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces: repeated }),
      traces: repeated,
    });
    expect(proposals).toEqual([
      expect.objectContaining({
        kind: "sequence-fuse",
        sequence: ["memory.recall", "memory.expand", "state.get"],
        occurrences: 3,
      }),
    ]);

    const oneExecution = trace([...workflow, ...workflow]);
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces: [oneExecution] }),
        traces: [oneExecution],
      }),
    ).toEqual([]);

    const repeatedRefWorkflow = Array.from({ length: 3 }, () =>
      trace([
        op("extensions.fovea_sketch", {}),
        op("extensions.fovea_focus", {}),
        op("extensions.fovea_focus", {}),
      ]),
    );
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces: repeatedRefWorkflow }),
        traces: repeatedRefWorkflow,
      }),
    ).toEqual([]);
  });

  it("does not quarantine healthy refs", () => {
    const traces: EntropyTraceInput[] = [
      trace([
        op("mcp.ok.run", { a: 1 }, "failed", "validate"),
        op("mcp.ok.run", { a: 1 }),
        op("mcp.ok.run", { a: 1 }),
      ]),
    ];
    const report = measureEntropy({ traces });
    expect(proposeEntropyReductions({ report, traces })).toEqual([]);
  });

  it("keeps repair rows as aliases without rewriting canonical action names", () => {
    const traces: EntropyTraceInput[] = [
      trace([op("memory.expand", { session: "s1" })]),
    ];
    const surface = surfaceOf([
      {
        ref: "memory.expand",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["session"],
          properties: { session: { type: "string" } },
        },
      },
    ]);
    const repairs = [
      { kind: "actionAlias" as const, ref: "memory.expand", from: "expandEntry", to: "expand" },
    ];
    const report = measureEntropy({ traces, surface, repairs });
    const proposals = proposeEntropyReductions({ report, traces, surface, repairs });
    expect(proposals).toEqual([]);
    expect(applyProposalsToSurface(surface, proposals)).toEqual(surface);
  });

  it("does not infer enums for dynamic strings or numeric ranges", () => {
    const surface = surfaceOf([
      {
        ref: "agents.run",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { model: { type: "string" } },
        },
      },
      {
        ref: "memory.expand",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxChars: { type: "number", minimum: 256, maximum: 24_000 },
          },
        },
      },
    ]);
    const traces = [
      trace([
        ...Array.from({ length: 7 }, () => op("agents.run", { model: "xai/grok" })),
        op("agents.run", { model: "openai/gpt" }),
        ...Array.from({ length: 6 }, () => op("memory.expand", { maxChars: 24_000 })),
        ...Array.from({ length: 2 }, () => op("memory.expand", { maxChars: 12_000 })),
      ]),
    ];
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces, surface }),
        traces,
        surface,
      }),
    ).toEqual([]);
  });

  it("routes explicitly marked vocabularies to declare-enum review, never auto", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: {
            format: { type: "string", "x-fabric-enum-candidate": true },
          },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 7 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
      ]),
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "declare-enum",
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
  });

  it("does not infer finite domains for undeclared keys or unknown refs", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["docx", "html", "pdf"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 4 }, () => op("mcp.report.render", { format: "pdf", dpi: 300 })),
        ...Array.from({ length: 4 }, () => op("mcp.report.render", { format: "pdf", dpi: 600 })),
      ]),
      trace([
        ...Array.from({ length: 6 }, () => op("mcp.ghost.run", { level: "info" })),
        ...Array.from({ length: 2 }, () => op("mcp.ghost.run", { level: "debug" })),
      ]),
    ];
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces, surface }),
        traces,
        surface,
      }),
    ).toEqual([]);
  });

  it("converges when the observed vocabulary equals the declared enum", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["html", "pdf"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 7 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
      ]),
    ];
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces, surface }),
        traces,
        surface,
      }),
    ).toEqual([]);
  });

  it("drops observations outside the declared domain and tightens to the remainder", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["html", "pdf", "web"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [
      trace([
        ...Array.from({ length: 6 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
        op("mcp.report.render", { format: "rtf" }),
      ]),
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "enum-tighten",
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      distinct: 2,
    });
  });

  it("weights pooled observations by count multiplicity", () => {
    const surface = surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["docx", "html", "pdf"] } },
        },
      },
    ]);
    const traces: EntropyTraceInput[] = [trace([op("mcp.report.render", { format: "pdf" })])];
    const valueObservations = [
      { ref: "mcp.report.render", key: "format", value: "pdf", count: 7 },
      { ref: "mcp.report.render", key: "format", value: "html", count: 1 },
    ];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces, surface }),
      traces,
      surface,
      valueObservations,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "enum-tighten",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
  });
});

describe("evaluateGate", () => {
  it("passes a strict decrease and fails any increase", () => {
    const { before, compiled } = compiledRatchet();
    const after = measureEntropy({
      traces: ratchetTraces(),
      surface: compiled,
      repairs: ratchetRepairs(),
    });
    const gate = evaluateGate(before, after);
    expect(gate.passed).toBe(true);
    expect(gate.delta).toBe(-0.01823);
    expect(before.staticScore).toBe(0.036458);
    expect(before.behavioralScore).toBe(0.286561);
    expect(after.staticScore).toBe(0.018229);
    expect(after.behavioralScore).toBe(0.28656);
    const regress = evaluateGate(after, before);
    expect(regress.passed).toBe(false);
    expect(regress.reasons[0]).toContain("score increased");
  });

  it("fails when successful calls drop", () => {
    const full = measureEntropy({ traces: ratchetTraces(), surface: ratchetSurface() });
    const partial = measureEntropy({
      traces: [trace([op("omp.read", { path: "src/a.ts", limit: 50 })])],
    });
    const gate = evaluateGate(full, partial);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join(" ")).toContain("successful calls dropped");
  });
});
