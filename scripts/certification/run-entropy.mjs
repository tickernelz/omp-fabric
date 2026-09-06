#!/usr/bin/env node
// Deterministic tool-entropy certification. Measures fixed corpora with the
// versioned entropy meter, verifies the exact math, proves the ratchet
// (compile proposals never increase the score and converge), and ingests
// synthetic session JSONL — all offline, with no model and no clocks inside
// the measured values.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentDir } from "../../src/core/agent-dir.ts";
import {
  ENTROPY_METRIC_VERSION,
  applyCompiledSurface,
  applyProposalsToSurface,
  compileEntropySurface,
  entropyReportHash,
  entropySessionEvidenceFromJsonl,
  entropySurfaceHash,
  entropyTracesFromSessionJsonl,
  entropyValueObservationsFromSessionJsonl,
  evaluateGate,
  loadCompiledSurface,
  measureEntropy,
  mergeObservationWindow,
  parseCompiledSurfaceArtifact,
  poolToValueObservations,
  proposeEntropyReductions,
  runEntropyTrial,
  saveCompiledSurface,
  schemaDigest,
  surfaceFreedomReport,
} from "../../dist/entropy/index.js";

const op = (ref, args, outcome = "succeeded", failureStage) => ({
  ref,
  args,
  outcome,
  ...(failureStage ? { failureStage } : {}),
});
const trace = (operations, taskKey) => ({
  operations,
  ...(taskKey ? { taskKey } : {}),
});
const surfaceOf = (actions) => ({ version: 1, actions });

const convergedTraces = () => [
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

const convergedSurface = () =>
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

const wobbleTraces = () => [
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

const ratchetTraces = () => [
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

const ratchetSurface = () =>
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
  { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
];

const structureTraces = () => [
  trace(
    [
      op("memory.recall", { query: "a" }),
      op("memory.expand", { session: "a" }),
      op("state.get", { key: "a" }),
    ],
    "loop",
  ),
  trace(
    [
      op("memory.recall", { query: "b" }),
      op("memory.expand", { session: "b" }),
      op("state.get", { key: "b" }),
    ],
    "loop",
  ),
  trace(
    [
      op("memory.recall", { query: "c" }),
      op("memory.expand", { session: "c" }),
      op("state.get", { key: "c" }),
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

const ingestionJsonl = () => {
  const envelope = {
    kind: "omp-fabric.execution",
    version: 1,
    outcome: "succeeded",
    phases: ["build"],
    operations: [
      {
        type: "call",
        sequence: 0,
        ref: "omp.read",
        args: { path: "src/a.ts", limit: 10 },
        outcome: "succeeded",
      },
      {
        type: "call",
        sequence: 1,
        ref: "omp.bash",
        args: { command: "ls" },
        outcome: "failed",
        failureStage: "invoke",
        error: "boom",
      },
    ],
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
  };
  // A second execution whose MCP calls keep no trace arguments but persist
  // verbatim audit args: the enum-tighten value corpus must come from audits.
  const renderFormats = [
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "html",
  ];
  const renderEnvelope = {
    kind: "omp-fabric.execution",
    version: 1,
    outcome: "succeeded",
    phases: ["build"],
    operations: renderFormats.map((format, index) => ({
      type: "call",
      sequence: index,
      ref: "mcp.report.render",
      args: {},
      outcome: "succeeded",
    })),
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
  };
  const renderAudits = renderFormats.map((format) => ({
    ref: "mcp.report.render",
    args: { format },
  }));
  const sessionLine = (id, trace, audits) =>
    JSON.stringify({
      id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName: "fabric_exec",
        content: [{ type: "text", text: "ok" }],
        details: { success: true, trace, audits, phases: ["build"] },
      },
    });
  return [
    "{ not json",
    JSON.stringify({
      id: "entry-0",
      type: "message",
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      id: "entry-model-1",
      type: "model_change",
      provider: "zro",
      modelId: "kimi-k3",
    }),
    sessionLine(
      "entry-1",
      envelope,
      [
        { ref: "omp.read", args: { path: "src/a.ts", limit: 10 } },
        { ref: "omp.bash", args: { command: "ls" } },
      ],
    ),
    JSON.stringify({
      id: "entry-model-2",
      type: "model_change",
      provider: "coralbricks",
      modelId: "glm-5.3-fp4",
    }),
    sessionLine("entry-2", renderEnvelope, renderAudits),
    "",
  ].join("\n");
};

export const runEntropyCertification = async (options = {}) => {
  const checks = [];
  const check = (id, passed, evidence) => {
    checks.push({ id, passed: Boolean(passed), evidence: evidence ?? "" });
  };

  // Determinism: identical inputs must produce an identical report hash.
  const wobble = measureEntropy({ traces: wobbleTraces() });
  const wobbleAgain = measureEntropy({ traces: wobbleTraces() });
  check(
    "determinism-double-run",
    entropyReportHash(wobble) === entropyReportHash(wobbleAgain),
    `hashes ${entropyReportHash(wobble)} vs ${entropyReportHash(wobbleAgain)}`,
  );

  // Converged corpus: canonical calls on a tight surface score exactly.
  const converged = measureEntropy({
    traces: convergedTraces(),
    surface: convergedSurface(),
  });
  check(
    "converged-corpus-exact",
    converged.score === 0.21875 &&
      converged.staticFreedom === 3.5 &&
      converged.shapeEntropyBits === 0 &&
      converged.churnRate === 0 &&
      converged.navigationRatio === 0 &&
      converged.flowEntropyBits === 0 &&
      converged.totals.succeeded === 4 &&
      converged.totals.actionOperations === 4,
    `score ${converged.score} static ${converged.staticFreedom} succeeded ${converged.totals.succeeded}`,
  );

  // Wobble corpus: exact math for every entropy species.
  const expand = wobble.refs.find((ref) => ref.ref === "memory.expand");
  check(
    "wobble-math-exact",
    Boolean(expand) &&
      expand.shapeEntropyBits === 0.811278 &&
      expand.failureStageEntropyBits === 1 &&
      expand.churnRate === 0.48 &&
      wobble.churnRate === 0.32 &&
      wobble.flowEntropyBits === 0.666667 &&
      wobble.navigationRatio === 0.083333 &&
      wobble.totals.invocationRejectionsPer1k === 166.666667,
    `shape ${expand?.shapeEntropyBits} stages ${expand?.failureStageEntropyBits} churn ${wobble.churnRate} flow ${wobble.flowEntropyBits}`,
  );

  // Ratchet: propose → apply → re-measure → gate, then converge.
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
  const kinds = proposals.map((proposal) => proposal.kind);
  check(
    "ratchet-proposals",
    kinds.length === 2 &&
      kinds.filter((kind) => kind === "enum-tighten").length === 1 &&
      kinds.filter((kind) => kind === "noise-quarantine").length === 1,
    `kinds ${kinds.join(",")}`,
  );
  const originalSurface = ratchetSurface();
  const originalJson = JSON.stringify(originalSurface);
  const compiledSurface = applyProposalsToSurface(originalSurface, proposals);
  check(
    "surface-apply-purity",
    JSON.stringify(originalSurface) === originalJson,
    "applyProposalsToSurface mutated its input",
  );
  const after = measureEntropy({
    traces: ratchetTraces(),
    surface: compiledSurface,
    repairs: ratchetRepairs(),
  });
  const gate = evaluateGate(before, after);
  check(
    "ratchet-monotone",
    gate.passed &&
      before.score === 0.323019 &&
      after.score === 0.304789 &&
      gate.delta === -0.01823,
    `score ${before.score} → ${after.score} delta ${gate.delta} reasons ${gate.reasons.join("; ")}`,
  );
  const roundTwo = proposeEntropyReductions({
    report: after,
    traces: ratchetTraces(),
    surface: compiledSurface,
    repairs: ratchetRepairs(),
  });
  check(
    "ratchet-converged",
    roundTwo.length === 0,
    `round-2 proposals ${roundTwo.map((proposal) => proposal.kind).join(",")}`,
  );

  // The autonomous compile loop: measure → propose → apply the mechanical
  // subset → re-measure → gate, then converge on the compiled artifact.
  // Repair rows remain guarded aliases and do not become surface rewrites.
  const compileInput = () => ({
    traces: ratchetTraces(),
    surface: ratchetSurface(),
    repairs: ratchetRepairs(),
  });
  const compiledOutcome = compileEntropySurface(compileInput());
  const overlayLive = ratchetSurface();
  const overlayLiveJson = JSON.stringify(overlayLive);
  const overlayApplied = applyCompiledSurface(overlayLive, compiledOutcome.artifact);
  check(
    "compiler-loop",
    compiledOutcome.status === "compiled" &&
      compiledOutcome.report.score === 0.323019 &&
      compiledOutcome.gate.passed === true &&
      compiledOutcome.after.score === 0.304789 &&
      compiledOutcome.gate.delta === -0.01823 &&
      compiledOutcome.artifact.actions.length === 1 &&
      compiledOutcome.artifact.actions[0].ref === "mcp.report.render" &&
      compiledOutcome.artifact.actions[0].baseSchemaDigest ===
        schemaDigest(
          ratchetSurface().actions.find((action) => action.ref === "mcp.report.render")
            .inputSchema,
        ) &&
      compiledOutcome.artifact.quarantined.length === 1 &&
      compiledOutcome.artifact.quarantined[0].ref === "mcp.flaky.run" &&
      compiledOutcome.artifact.applied.length === 2,
    `status ${compiledOutcome.status} score ${compiledOutcome.report.score} → ${compiledOutcome.after?.score}`,
  );
  const recompiled = compileEntropySurface({
    ...compileInput(),
    artifact: compiledOutcome.artifact,
  });
  check(
    "compiler-converged",
    recompiled.status === "converged" &&
      recompiled.artifact === compiledOutcome.artifact &&
      recompiled.proposals.length === 0,
    `status ${recompiled.status} proposals ${recompiled.proposals.map((p) => p.kind).join(",")}`,
  );
  check(
    "compiled-surface-overlay",
    JSON.stringify(overlayLive) === overlayLiveJson &&
      overlayApplied.actions.length === 2 &&
      overlayApplied.actions.some(
        (action) =>
          action.ref === "mcp.report.render" &&
          action.inputSchema.properties.format.enum.length === 2,
      ) &&
      !overlayApplied.actions.some((action) => action.ref === "mcp.flaky.run"),
    `overlay actions ${overlayApplied.actions.map((a) => a.ref).join(",")}`,
  );
  const divergentObservations = [
    ...Array.from({ length: 8 }, () => ({
      ref: "mcp.report.render",
      key: "format",
      value: "pdf",
    })),
    { ref: "mcp.report.render", key: "format", value: "html" },
    { ref: "mcp.report.render", key: "format", value: "html" },
  ];
  const divergent = compileEntropySurface({
    traces: [
      trace([
        ...Array.from({ length: 8 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "web" }),
      ]),
    ],
    surface: ratchetSurface(),
    valueObservations: divergentObservations,
  });
  check(
    "compiler-gate-reject",
    divergent.status === "rejected" &&
      divergent.gate.passed === false &&
      divergent.gate.reasons.some((reason) => reason.includes("mcp.report.render")) &&
      divergent.artifact === undefined,
    `status ${divergent.status} reasons ${divergent.gate?.reasons.join("; ")}`,
  );
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-entropy-store-"));
  const saved = saveCompiledSurface(storeDir, compiledOutcome.artifact);
  const reloaded = loadCompiledSurface(storeDir);
  const noopSave = saveCompiledSurface(storeDir, compiledOutcome.artifact);
  check(
    "compiled-store-roundtrip",
    saved.written === true &&
      noopSave.written === false &&
      reloaded.error === undefined &&
      JSON.stringify(reloaded.file) === JSON.stringify(compiledOutcome.artifact),
    `written ${saved.written}/${noopSave.written} error ${reloaded.error ?? "none"}`,
  );
  fs.rmSync(storeDir, { recursive: true, force: true });

  // Score decomposition: the surface share prices the potential the corpus
  // used; everything else is freedom models exercised.
  check(
    "score-decomposition",
    converged.staticScore === 0.21875 &&
      converged.behavioralScore === 0 &&
      wobble.staticScore === 0 &&
      wobble.behavioralScore === wobble.score &&
      before.staticScore === 0.036458 &&
      before.behavioralScore === 0.286561 &&
      Math.abs(before.staticScore + before.behavioralScore - before.score) < 1e-6,
    `static ${before.staticScore} + behavioral ${before.behavioralScore} vs score ${before.score}`,
  );

  // Structure proposals: sequence fusion and overload splitting.
  const structureReport = measureEntropy({ traces: structureTraces() });
  const structureProposals = proposeEntropyReductions({
    report: structureReport,
    traces: structureTraces(),
  });
  const fuse = structureProposals.find(
    (proposal) => proposal.kind === "sequence-fuse",
  );
  const split = structureProposals.find(
    (proposal) => proposal.kind === "overload-split",
  );
  check(
    "structure-proposals",
    Boolean(fuse) &&
      fuse.occurrences === 3 &&
      JSON.stringify(fuse.sequence) ===
        JSON.stringify(["memory.recall", "memory.expand", "state.get"]) &&
      Boolean(split) &&
      split.clusters.length === 2 &&
      JSON.stringify(split.clusters.map((cluster) => cluster.keys)) ===
        JSON.stringify([
          ["key", "value"],
          ["limit", "prefix"],
        ]) &&
      !structureProposals.some(
        (proposal) =>
          proposal.kind === "enum-tighten" || proposal.kind === "noise-quarantine",
      ),
    `proposals ${structureProposals.map((proposal) => proposal.kind).join(",")}`,
  );

  // Session JSONL ingestion: malformed and non-trace lines are skipped;
  // guarded trace envelopes become meter traces.
  const ingestionLines = ingestionJsonl().split("\n");
  const ingestedTraces = entropyTracesFromSessionJsonl(ingestionLines);
  const ingestionReport = measureEntropy({ traces: ingestedTraces });
  check(
    "session-jsonl-ingestion",
    ingestedTraces.length === 2 &&
      ingestionReport.totals.operations === 10 &&
      ingestionReport.totals.succeeded === 9 &&
      ingestionReport.totals.failed === 1,
    `traces ${ingestedTraces.length} ops ${ingestionReport.totals.operations}`,
  );

// Per-model attribution: traces stamp the producing model from the session
  // scan, and each model's behavioral terms measure against the same
  // surface. The attribution names which model exercised the freedom.
  check(
    "session-model-attribution",
    ingestionReport.byModel.length === 2 &&
      ingestionReport.byModel[0].model === "coralbricks/glm-5.3-fp4" &&
      ingestionReport.byModel[0].operations === 8 &&
      ingestionReport.byModel[0].succeeded === 8 &&
      ingestionReport.byModel[0].behavioralScore === 0 &&
      ingestionReport.byModel[1].model === "zro/kimi-k3" &&
      ingestionReport.byModel[1].operations === 2 &&
      ingestionReport.byModel[1].succeeded === 1 &&
      ingestionReport.byModel[1].behavioralScore === 0,
    `models ${ingestionReport.byModel.map((entry) => `${entry.model}:${entry.operations}`).join(",")}`,
  );

  // Verbatim audit observations: the value corpus for refs whose trace
  // projection drops values. The render calls keep empty trace args, so the
  // enum-tighten proposal can only come from the audits.
  const valueObservations = entropyValueObservationsFromSessionJsonl(ingestionLines);
  const renderObservations = valueObservations.filter(
    (observation) => observation.ref === "mcp.report.render",
  );
  const auditSurface = surfaceOf([
    {
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", "x-fabric-enum-candidate": true },
        },
        additionalProperties: false,
      },
    },
  ]);
  const auditReport = measureEntropy({ traces: ingestedTraces, surface: auditSurface });
  const fromTraces = proposeEntropyReductions({
    report: auditReport,
    traces: ingestedTraces,
    surface: auditSurface,
  });
  const fromAudits = proposeEntropyReductions({
    report: auditReport,
    traces: ingestedTraces,
    surface: auditSurface,
    valueObservations,
  });
  const auditProposal = fromAudits.find((proposal) => proposal.kind === "declare-enum");
  check(
    "audit-value-observations",
    valueObservations.length === 11 &&
      renderObservations.length === 8 &&
      !fromTraces.some(
        (proposal) => proposal.kind === "enum-tighten" || proposal.kind === "declare-enum",
      ) &&
      Boolean(auditProposal) &&
      auditProposal.ref === "mcp.report.render" &&
      auditProposal.key === "format" &&
      JSON.stringify(auditProposal.values) === JSON.stringify(["pdf", "html"]),
    `observations ${valueObservations.length} renders ${renderObservations.length}`,
  );

  // Open-domain guard: a stable vocabulary on an unannotated free parameter
  // proves neither a closed domain nor an enum declaration candidate.
  const guardSurface = () =>
    surfaceOf([
      {
        ref: "mcp.report.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string" } },
        },
      },
    ]);
  const guardTraces = [
    trace(
      [
        ...Array.from({ length: 7 }, () => op("mcp.report.render", { format: "pdf" })),
        op("mcp.report.render", { format: "html" }),
      ],
      "guard",
    ),
  ];
  const guardOutcome = compileEntropySurface({
    traces: guardTraces,
    surface: guardSurface(),
  });
  check(
    "closed-domain-guard",
    guardOutcome.status === "converged" &&
      guardOutcome.artifact === undefined &&
      guardOutcome.proposals.length === 0,
    `status ${guardOutcome.status} proposals ${guardOutcome.proposals.map((p) => p.kind).join(",")}`,
  );

  // Pooled evidence: windows below the observation threshold pool into
  // counts that clear it, unchanged sessions merge nothing, and identical
  // multisets never merge twice.
  const poolSurface = () =>
    surfaceOf([
      {
        ref: "mcp.flags.set",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["level"],
          properties: {
            level: { type: "string", enum: ["debug", "error", "info", "warn"] },
          },
        },
      },
    ]);
  const poolWindowA = {
    file: "a.jsonl",
    observations: [
      { ref: "mcp.flags.set", key: "level", value: "info", count: 4 },
      { ref: "mcp.flags.set", key: "level", value: "warn" },
    ],
  };
  const poolWindowB = {
    file: "b.jsonl",
    observations: [
      { ref: "mcp.flags.set", key: "level", value: "info", count: 3 },
      { ref: "mcp.flags.set", key: "level", value: "error" },
    ],
  };
  const pooledOnce = mergeObservationWindow(undefined, [poolWindowA, poolWindowB]);
  const pooledAgain = mergeObservationWindow(pooledOnce.file, [poolWindowA, poolWindowB]);
  const poolTrace = [trace([op("mcp.flags.set", { level: "info" })])];
  const poolReport = measureEntropy({ traces: poolTrace, surface: poolSurface() });
  const pooledProposals = proposeEntropyReductions({
    report: poolReport,
    traces: poolTrace,
    surface: poolSurface(),
    valueObservations: poolToValueObservations(pooledOnce.file),
  });
  const pooledTighten = pooledProposals.find((proposal) => proposal.kind === "enum-tighten");
  check(
    "pooled-evidence",
    pooledOnce.mergedSessions === 2 &&
      pooledAgain.mergedSessions === 0 &&
      pooledAgain.skippedSessions === 2 &&
      JSON.stringify(pooledOnce.file) === JSON.stringify(pooledAgain.file) &&
      Boolean(pooledTighten) &&
      pooledTighten.ref === "mcp.flags.set" &&
      pooledTighten.key === "level" &&
      JSON.stringify(pooledTighten.values) === JSON.stringify(["info", "error", "warn"]) &&
      pooledTighten.calls === 9,
    `merged ${pooledOnce.mergedSessions}/${pooledAgain.mergedSessions} values ${pooledTighten?.values.join(",")}`,
  );

  // Audited trial replay: refs with verbatim audits classify from the
  // audit args, never the projected trace args, and a compiled rejection
  // of an audited call counts as a cost because the outcome is unknown.
  const trialLive = () =>
    surfaceOf([
      {
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["docx", "html", "pdf"] } },
        },
      },
    ]);
  const trialArtifact = {
    version: 1,
    metricVersion: 2,
    actions: [
      {
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["pdf", "html"] } },
        },
        baseSchemaDigest: schemaDigest(
          trialLive().actions.find((action) => action.ref === "mcp.render").inputSchema,
        ),
      },
    ],
    quarantined: [],
    applied: [],
    gate: { passed: true, beforeScore: 0.02, afterScore: 0.01, reasons: [] },
    evidenceDigest: "trial",
  };
  const trialTraces = [
    trace(
      [
        op("mcp.render", {}),
        op("mcp.render", {}),
        op("mcp.render", {}, "failed", "invoke"),
      ],
      "trial",
    ),
  ];
  const trialAudits = [
    { ref: "mcp.render", args: { format: "pdf" } },
    { ref: "mcp.render", args: { format: "docx" } },
    { ref: "mcp.render", args: { format: "html" } },
  ];
  const trialReport = runEntropyTrial({
    traces: trialTraces,
    live: trialLive(),
    artifact: trialArtifact,
    auditCalls: trialAudits,
  });
  check(
    "trial-audit-replay",
    trialReport.totals.operations === 3 &&
      trialReport.totals.bothAccept === 2 &&
      trialReport.totals.tighteningCost === 1 &&
      trialReport.verdict === "costly",
    `ops ${trialReport.totals.operations} both-accept ${trialReport.totals.bothAccept} costs ${trialReport.totals.tighteningCost}`,
  );

  // Real session corpus (opt-in, development and CI). A live surface
  // snapshot (/fabric entropy export <path>) adds static freedom and keys
  // the report to the surface hash.
  let corpus;
  let surfaceSummary;
  let trialSummary;
  if (options.surfacePath && !options.sessionsDir) {
    check("corpus-mode", false, "--surface requires --sessions");
  }
  if (options.sessionsDir) {
    const sessionsDir = options.sessionsDir;
    if (!fs.existsSync(sessionsDir)) {
      check("corpus-mode", false, `sessions directory not found: ${sessionsDir}`);
    } else {
      const files = fs
        .readdirSync(sessionsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
      const lines = [];
      for (const file of files) {
        lines.push(
          ...fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n"),
        );
      }
      const evidence = entropySessionEvidenceFromJsonl(lines);
      const traces = evidence.traces;
      let surface;
      let catalogDigest = "(sessions)";
      if (options.surfacePath) {
        const raw = JSON.parse(fs.readFileSync(options.surfacePath, "utf8"));
        if (!raw || raw.version !== 1 || !Array.isArray(raw.actions)) {
          throw new Error("surface snapshot must be { version: 1, actions: [...] }");
        }
        surface = {
          version: 1,
          actions: raw.actions.filter(
            (action) => action && typeof action.ref === "string",
          ),
        };
        catalogDigest = entropySurfaceHash(surface);
        const freedom = surfaceFreedomReport(surface);
        surfaceSummary = {
          path: options.surfacePath,
          actions: freedom.actions.length,
          freedomTotal: freedom.total,
          freedomMean: freedom.mean,
          digest: catalogDigest,
        };
      }
      corpus = measureEntropy({
        traces,
        ...(surface ? { surface } : {}),
        catalogDigest,
      });
      check(
        "corpus-mode",
        corpus.totals.operations > 0,
        `files ${files.length} traces ${traces.length} operations ${corpus.totals.operations}`,
      );
      // Counterfactual trial (opt-in with --trial): replay the corpus's
      // recorded calls against the declared surface and the compiled
      // artifact. The hard check is the falsifiable hypothesis: the
      // compile never rejects a held-out successful call. Quarantine
      // costs are reported, not failed, because retiring a ref that once
      // succeeded is what a quarantine is allowed to do.
      if (options.trial) {
        if (!surface) {
          check("trial-mode", false, "--trial requires --surface");
        } else {
          let artifact;
          if (options.artifactPath) {
            const raw = JSON.parse(fs.readFileSync(options.artifactPath, "utf8"));
            artifact = parseCompiledSurfaceArtifact(raw);
            if (!artifact) {
              check("trial-mode", false, `artifact is invalid: ${options.artifactPath}`);
            }
          } else {
            const agentDir = resolveAgentDir();
            const loaded = loadCompiledSurface(agentDir);
            artifact = loaded.file;
            if (!artifact) {
              check(
                "trial-mode",
                false,
                loaded.error ?? `no compiled surface in the agent dir ${agentDir} (pass --artifact <path>)`,
              );
            }
          }
          if (artifact) {
            const trial = runEntropyTrial({
              traces,
              live: surface,
              artifact,
              auditCalls: evidence.auditCalls,
            });
            trialSummary = {
              verdict: trial.verdict,
              declaredScore: trial.declaredScore,
              effectiveScore: trial.effectiveScore,
              delta: trial.delta,
              totals: trial.totals,
              divergences: trial.divergences,
            };
            check(
              "trial-costs",
              trial.totals.tighteningCost === 0,
              `${trial.totals.tighteningCost} held-out successful calls rejected by the compiled schema`,
            );
          }
        }
      }
    }
  }

  const evaluation = {
    passed: checks.every((entry) => entry.passed),
    checks,
    failed: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
  };
  return {
    kind: "omp-fabric.entropy-certification",
    version: 1,
    metricVersion: ENTROPY_METRIC_VERSION,
    fixtures: {
      converged: {
        score: converged.score,
        staticFreedom: converged.staticFreedom,
        totals: converged.totals,
      },
      wobble: {
        score: wobble.score,
        shapeEntropyBits: wobble.shapeEntropyBits,
        failureStageEntropyBits: wobble.failureStageEntropyBits,
        churnRate: wobble.churnRate,
        navigationRatio: wobble.navigationRatio,
        flowEntropyBits: wobble.flowEntropyBits,
      },
      ratchet: {
        beforeScore: before.score,
        afterScore: after.score,
        delta: gate.delta,
        proposals,
        gate,
      },
      compiler: {
        status: compiledOutcome.status,
        beforeScore: compiledOutcome.report.score,
        afterScore: compiledOutcome.after?.score,
        applied: compiledOutcome.artifact?.applied ?? [],
      },
      structure: {
        proposals: structureProposals,
      },
      ingestion: {
        traces: ingestedTraces.length,
        operations: ingestionReport.totals.operations,
        valueObservations: valueObservations.length,
        byModel: ingestionReport.byModel,
      },
    },
    ...(corpus ? { corpus } : {}),
    ...(surfaceSummary ? { surface: surfaceSummary } : {}),
    ...(trialSummary ? { trial: trialSummary } : {}),
    evaluation,
  };
};

export const formatEntropyHumanReport = (report) => {
  const lines = [
    `Entropy certification (metric v${report.metricVersion})`,
    `  converged: score ${report.fixtures.converged.score} · static freedom ${report.fixtures.converged.staticFreedom}`,
    `  wobble: shape ${report.fixtures.wobble.shapeEntropyBits} bits · stages ${report.fixtures.wobble.failureStageEntropyBits} · churn ${report.fixtures.wobble.churnRate} · flow ${report.fixtures.wobble.flowEntropyBits}`,
    `  ratchet: ${report.fixtures.ratchet.beforeScore} → ${report.fixtures.ratchet.afterScore} (delta ${report.fixtures.ratchet.delta}) · ${report.fixtures.ratchet.proposals.length} proposals`,
  ];
  if (report.corpus) {
    lines.push(
      `  corpus: ${report.corpus.totals.operations} operations · score ${report.corpus.score} · rejections/1k ${report.corpus.totals.invocationRejectionsPer1k}`,
    );
  }
  if (report.surface) {
    lines.push(
      `  surface: ${report.surface.actions} actions · freedom ${report.surface.freedomTotal} (mean ${report.surface.freedomMean}) · digest ${report.surface.digest.slice(0, 12)}`,
    );
  }
  if (report.trial) {
    const totals = report.trial.totals;
    lines.push(
      `  trial: ${report.trial.verdict} · score ${report.trial.declaredScore} → ${report.trial.effectiveScore} (delta ${report.trial.delta}) · wins ${totals.typedFailureWin + totals.quarantineWin} · costs ${totals.tighteningCost + totals.quarantineCost}`,
    );
  }
  for (const entry of report.evaluation.checks) {
    lines.push(
      `  ${entry.passed ? "✓" : "✗"} ${entry.id}${entry.passed ? "" : ` — ${entry.evidence}`}`,
    );
  }
  lines.push(report.evaluation.passed ? "  PASS" : "  FAIL");
  return lines.join("\n");
};
