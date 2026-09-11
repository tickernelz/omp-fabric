import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricLcmDashboard } from "../src/ui/lcm-dashboard.js";
import { lcmChecks, worstSeverity, type LcmDiagnostics } from "../src/compaction/lcm-doctor.js";
import type { LcmDashboardJob, LcmDashboardNode, LcmStatusSource } from "../src/fabric-runtime-state.js";

const NOW = 1_700_000_000_000;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = () => ({ requestRender: vi.fn(), terminal: { rows: 40 } }) as unknown as TUI;

const node = (overrides: Partial<LcmDashboardNode> & { nodeId: string }): LcmDashboardNode => ({
  sessionId: "session-1",
  kind: "condensed",
  depth: 0,
  state: "ready",
  modelHash: "sha256:model",
  text: "condensed summary",
  children: [],
  sources: [],
  createdAt: NOW,
  ...overrides,
});

const diagnostics = (overrides: Partial<LcmDiagnostics> = {}): LcmDiagnostics => ({
  projectKey: "v1:devino:2096:189655",
  ledgerPath: "/state/lcm/ledger.sqlite",
  ledgerBytes: 84_000_000,
  ledgerState: "healthy",
  runtimeError: undefined,
  sessionId: "01a08f23-d247-7159-90c3-e4d891c8237d",
  sessionFile: "/sessions/01a08f23.jsonl",
  sessionFilePresent: true,
  liveBranchEntries: 40,
  ledgerSessionEntries: 40,
  ledgerEntries: 5_141,
  activeSources: 40,
  coveredSources: 40,
  backlogThreshold: 32,
  pendingNodes: 0,
  pendingJobs: 0,
  runningJobs: 0,
  failedJobs: 0,
  expiredLeases: 0,
  modelSummaries: true,
  summaryModel: "anthropic/claude-haiku",
  budgetCalls: Number.POSITIVE_INFINITY,
  usedCalls: 4,
  withinBudget: true,
  reconciliation: { errors: 0, raced: 0, absent: 0, reasons: [] },
  repairs: [],
  autoRepairs: [],
  ...overrides,
});

const report = () => ({
  projectKey: "v1:devino:2096:189655",
  sessionId: "session-1",
  state: "healthy",
  ledgerState: "healthy",
  degraded: undefined,
  summaryModel: "anthropic/claude-haiku",
  rawEntries: 5_141,
  sessionEntries: 40,
  modelNodes: 12,
  emergencyNodes: 3,
  pendingNodes: 0,
  pendingJobs: 0,
  upgradableNodes: 1,
  usage: { calls: 4, inputTokens: 100, outputTokens: 20, cost: 0.031, wallMs: 55_000 },
  budget: { calls: Number.POSITIVE_INFINITY, sessionCalls: 16, wallMs: 7_200_000 },
  reconciliation: undefined,
});

interface StubOptions {
  nodes?: LcmDashboardNode[];
  preview?: ReturnType<LcmStatusSource["preview"]>;
  jobs?: LcmDashboardJob[];
  diagnostics?: Partial<LcmDiagnostics>;
  detail?: ReturnType<LcmStatusSource["node"]>;
  entry?: ReturnType<LcmStatusSource["source"]>;
}

const stub = (options: StubOptions = {}) => {
  const all = options.nodes ?? [node({ nodeId: "node-1" })];
  const calls = {
    report: vi.fn(report),
    coverage: vi.fn(() => ({ active: 40, covered: 10 })),
    preview: vi.fn(() => options.preview ?? {
      text: "assembled frontier text",
      nodes: all.length,
      summaryBytes: 1_200,
      sourceBytes: 4_700_000,
      coveredSources: 10,
      activeSources: 40,
    }),
    coverageMap: vi.fn(() =>
      Array.from({ length: 40 }, (_value, index) => ({ key: `entry-${index}`, covered: index < 10 })),
    ),
    nodes: vi.fn((limit?: number, offset?: number) => all.slice(offset ?? 0, (offset ?? 0) + (limit ?? all.length))),
    node: vi.fn(() => options.detail),
    source: vi.fn(() => options.entry),
    diagnostics: vi.fn(() => diagnostics(options.diagnostics ?? {})),
    repair: vi.fn(async (id: "reconcile" | "readback" | "leases" | "jobs") => ({
      id,
      changed: true,
      detail: "7 entries imported",
      at: NOW,
    })),
    jobs: vi.fn(() => options.jobs ?? []),
  };
  return { source: calls as unknown as LcmStatusSource, calls };
};

const opened: FabricLcmDashboard[] = [];
const open = (source: LcmStatusSource | undefined, done = vi.fn()): FabricLcmDashboard => {
  const dashboard = new FabricLcmDashboard(tui(), theme, () => source, done);
  opened.push(dashboard);
  return dashboard;
};

afterEach(() => {
  for (const dashboard of opened.splice(0)) dashboard.dispose();
});

describe("Fabric LCM dashboard", () => {
  it("opens on health and reads every ledger projection once per refresh", () => {
    const { source, calls } = stub();
    const rendered = open(source).render(120).join("\n");

    expect(rendered).toContain("Fabric \u00b7 LCM");
    expect(rendered).toContain("1 health");
    expect(rendered).toContain("2 graph");
    expect(rendered).toContain("10/40 covered 25%");
    expect(rendered).toContain("40 live \u00b7 40 stored");
    expect(rendered).toContain("ledger 5141");
    expect(rendered).not.toContain("Infinity");
    expect(calls.report).toHaveBeenCalledTimes(1);
    expect(calls.diagnostics).toHaveBeenCalledTimes(1);
    expect(calls.nodes).toHaveBeenCalledWith(200, 0);
  });

  it("calls a session whose file is not written yet priming, not degraded", () => {
    const { source } = stub({
      diagnostics: {
        sessionFilePresent: false,
        liveBranchEntries: 12,
        ledgerSessionEntries: 0,
        activeSources: 0,
        coveredSources: 0,
        reconciliation: { errors: 0, raced: 0, absent: 1, reasons: [] },
      },
    });
    const rendered = open(source).render(120).join("\n");

    expect(rendered).toContain("priming");
    expect(rendered).not.toContain("degraded");
    expect(rendered).toContain("file not written yet");
    expect(rendered).toContain("session file is not on disk yet");
  });

  it("reports an unreadable session file as a failure with a reconcile repair", () => {
    const { source, calls } = stub({
      diagnostics: { reconciliation: { errors: 1, raced: 0, absent: 0, reasons: [] } },
    });
    const dashboard = open(source);
    const rendered = dashboard.render(120).join("\n");

    expect(rendered).toContain("degraded");
    expect(rendered).toContain("1 unreadable session file(s)");

    dashboard.handleInput("j");
    dashboard.handleInput("j");
    dashboard.handleInput("j");
    dashboard.handleInput("r");

    expect(calls.repair).toHaveBeenCalledWith("reconcile");
  });

  it("runs the first offered repair with R and shows its outcome", async () => {
    const { source, calls } = stub({
      diagnostics: { liveBranchEntries: 12, ledgerSessionEntries: 5 },
    });
    const dashboard = open(source);
    dashboard.render(120);
    dashboard.handleInput("R");
    await vi.waitFor(() => expect(calls.repair).toHaveBeenCalledWith("readback"));

    expect(dashboard.render(120).join("\n")).toContain("repaired \u00b7 7 entries imported");
  });

  it("pages the graph tab and inspects a node", () => {
    const all = Array.from({ length: 260 }, (_value, index) =>
      node({ nodeId: `node-${String(index).padStart(3, "0")}` }),
    );
    const detail = { node: all[0]!, revisions: [], ancestors: [] };
    const { source, calls } = stub({ nodes: all, detail });
    const dashboard = open(source);

    dashboard.handleInput("2");
    expect(dashboard.render(120).join("\n")).toContain("condensed model");

    dashboard.handleInput("]");
    expect(calls.nodes).toHaveBeenLastCalledWith(200, 200);
    dashboard.handleInput("[");
    expect(calls.nodes).toHaveBeenLastCalledWith(200, 0);

    dashboard.handleInput("\r");
    expect(calls.node).toHaveBeenCalledWith("node-000");
    expect(dashboard.render(120).join("\n")).toContain("sources (0)");
  });

  it("draws the coverage grid and the assembled preview", () => {
    const { source } = stub();
    const dashboard = open(source);
    dashboard.handleInput("3");
    const rendered = dashboard.render(120).join("\n");

    expect(rendered).toContain("40 stored entries");
    expect(rendered).toContain("stored payload 4.5 MB");
    expect(rendered).toContain("assembled frontier text");
    expect(rendered).toContain("\u2588");
    expect(rendered).toContain("\u2591");
  });

  it("lists maintenance jobs failure-first and offers both job repairs", async () => {
    const jobs: LcmDashboardJob[] = [
      { jobId: "job:b", nodeId: "leaf:bbb", state: "failed", attempts: 3, error: "budget exhausted", nextRetryAt: 0, updatedAt: NOW },
      { jobId: "job:a", nodeId: "leaf:aaa", state: "completed", attempts: 1, nextRetryAt: 0, updatedAt: NOW - 10 },
    ];
    const { source, calls } = stub({ jobs, diagnostics: { failedJobs: 1, expiredLeases: 2 } });
    const dashboard = open(source);
    dashboard.handleInput("4");
    const rendered = dashboard.render(120).join("\n");
    const rows = rendered.split("\n").filter((line) => line.includes("leaf:"));

    expect(rows[0]).toContain("leaf:bbb");
    expect(rows[0]).toContain("budget exhausted");
    expect(rows[1]).toContain("leaf:aaa");

    dashboard.handleInput("r");
    await vi.waitFor(() => expect(dashboard.render(120).join("\n")).toContain("repaired"));
    expect(calls.repair).toHaveBeenCalledWith("jobs");

    dashboard.handleInput("l");
    await vi.waitFor(() => expect(calls.repair).toHaveBeenCalledWith("leases"));
  });

  it("closes on escape and explains an unopened ledger", () => {
    const done = vi.fn();
    const { source } = stub();
    open(source, done).handleInput("\u001b");
    expect(done).toHaveBeenCalledTimes(1);

    expect(open(undefined).render(120).join("\n")).toContain("LCM ledger unavailable");
  });

  it("labels the previous and current revision of a node that was rewritten", () => {
    const rewritten = node({ nodeId: "node-root", sources: [{ sessionId: "session-1", entryId: "entry-1", revision: 1, payloadHash: "hash-1" }] });
    const detail = {
      node: rewritten,
      revisions: [
        { revision: 1, text: "deterministic excerpt", modelHash: "emergency", createdAt: NOW },
        { revision: 2, text: "model rewrote this", modelHash: "sha256:model", createdAt: NOW },
      ],
      ancestors: ["node-grandparent", "node-parent"],
    };
    const entry = { payloadJson: "{}", content: "original text", role: "user", createdAt: NOW };
    const { source, calls } = stub({ nodes: [rewritten], detail, entry });
    const dashboard = open(source);
    dashboard.handleInput("2");
    dashboard.handleInput("\r");
    const rendered = dashboard.render(120).join("\n");

    expect(calls.node).toHaveBeenCalledWith("node-root");
    expect(rendered).toContain("previous revision 1 \u00b7 excerpt");
    expect(rendered).toContain("current revision 2 \u00b7 model");
    expect(rendered).toContain("node-grandparent \u203a node-parent");
    expect(rendered).toContain("session-1/entry-1@1");

    dashboard.handleInput("\r");

    expect(calls.source).toHaveBeenCalledWith("session-1", "entry-1", 1);
    expect(dashboard.render(120).join("\n")).toContain("original text");
  });

  it("distinguishes a deterministic excerpt node from a model-written node", () => {
    const { source } = stub({
      nodes: [node({ nodeId: "node-model" }), node({ nodeId: "node-excerpt", modelHash: "emergency" })],
    });
    const dashboard = open(source);
    dashboard.handleInput("2");
    const rows = dashboard.render(120).join("\n").split("\n");

    expect(rows.find((line) => line.includes("node-model"))).toContain("condensed model");
    expect(rows.find((line) => line.includes("node-excer"))).toContain("condensed excerpt");
  });

  it("reports a compression figure once the frontier covers the session", () => {
    const { source } = stub({ preview: { text: "assembled frontier text", nodes: 1, summaryBytes: 1_000, sourceBytes: 4_000, coveredSources: 40, activeSources: 40 } });
    const dashboard = open(source);
    dashboard.handleInput("3");

    expect(dashboard.render(120).join("\n")).toContain("25% of the session payload it replaces");
  });
});

describe("LCM checks", () => {
  it("holds a clean deployment at ok", () => {
    expect(worstSeverity(lcmChecks(diagnostics()))).toBe("ok");
  });

  it("warns only once the uncovered backlog can start a summary", () => {
    const below = lcmChecks(diagnostics({ coveredSources: 20, backlogThreshold: 32 }));
    const above = lcmChecks(diagnostics({ coveredSources: 0, backlogThreshold: 32 }));

    expect(below.find((check) => check.id === "coverage")?.severity).toBe("info");
    expect(above.find((check) => check.id === "coverage")?.severity).toBe("warn");
  });

  it("offers a job repair for failures and a lease repair for stuck leases", () => {
    const failed = lcmChecks(diagnostics({ failedJobs: 2 })).find((check) => check.id === "jobs");
    const stuck = lcmChecks(diagnostics({ expiredLeases: 1 })).find((check) => check.id === "jobs");

    expect(failed?.repair).toBe("jobs");
    expect(stuck?.repair).toBe("leases");
  });

  it("names an exhausted budget instead of blaming the model", () => {
    const check = lcmChecks(diagnostics({ withinBudget: false, budgetCalls: 8, usedCalls: 8 })).find(
      (candidate) => candidate.id === "model",
    );

    expect(check?.severity).toBe("warn");
    expect(check?.detail).toContain("8/8 calls today");
  });
});
