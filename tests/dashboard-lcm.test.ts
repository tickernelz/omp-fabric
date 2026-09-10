import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricDashboard } from "../src/ui/dashboard.js";
import { migrationDropReasons } from "../src/storage/lcm-migration.js";
import { lcmStatusLabel, lcmStatusLine, reconcileLcmState } from "../src/compaction/lcm-status.js";
import type { LcmDashboardNode, LcmStatusSource } from "../src/fabric-runtime-state.js";
import type { FabricDashboardSnapshot } from "../src/ui/types.js";

const NOW = 1_700_000_000_000;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = () => ({ requestRender: vi.fn(), terminal: { rows: 40 } }) as unknown as TUI;

const snapshot = (): FabricDashboardSnapshot => ({
  now: NOW,
  main: {
    id: "session:main",
    name: "Main",
    kind: "main",
    status: "idle",
    runner: "omp",
    transport: "host",
    cwd: "/tmp/project",
    sessionId: "main",
    startedAt: NOW - 1_000,
    updatedAt: NOW,
    pendingMessages: false,
    local: true,
  },
  peers: [],
  runs: [],
  agents: [],
  actors: [],
  componentGraph: { components: [], edges: [], cycles: [] },
  globalActors: [],
  state: [],
  events: [],
});

const node = (
  overrides: Partial<LcmDashboardNode> & { nodeId: string },
): LcmDashboardNode => ({
  sessionId: "session-1",
  branch: "main",
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

const report = (
  overrides: Partial<ReturnType<LcmStatusSource["report"]>> = {},
): ReturnType<LcmStatusSource["report"]> => {
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

interface StubOptions {
  nodes?: LcmDashboardNode[];
  coverage?: { active: number; covered: number };
  coverageMap?: Array<{ key: string; covered: boolean }>;
  preview?: ReturnType<LcmStatusSource["preview"]>;
  report?: Partial<ReturnType<LcmStatusSource["report"]>>;
  detail?: ReturnType<LcmStatusSource["node"]>;
  entry?: ReturnType<LcmStatusSource["source"]>;
}

const stub = (options: StubOptions = {}) => {
  const all = options.nodes ?? [node({ nodeId: "node-1" })];
  const calls = {
    report: vi.fn(() => report(options.report ?? {})),
    coverage: vi.fn(() => options.coverage ?? { active: 40, covered: 10 }),
    preview: vi.fn(
      () =>
        options.preview ?? {
          text: "assembled frontier text",
          nodes: all.length,
          summaryBytes: 1_200,
          sourceBytes: 4_700_000,
          coveredSources: 15,
          activeSources: 5_368,
        },
    ),
    coverageMap: vi.fn(
      () =>
        options.coverageMap ??
        Array.from({ length: 40 }, (_value, index) => ({
          key: `entry-${index}`,
          covered: index < 10,
        })),
    ),
    nodes: vi.fn((limit?: number, offset?: number) =>
      all.slice(offset ?? 0, (offset ?? 0) + (limit ?? all.length)),
    ),
    node: vi.fn(() => options.detail),
    source: vi.fn(() => options.entry),
  };
  const source: LcmStatusSource = calls;
  return { source, calls };
};

const openLcm = (
  source: LcmStatusSource | undefined,
  width = 120,
): { dashboard: FabricDashboard; rendered: string } => {
  const dashboard = new FabricDashboard(
    tui(),
    theme,
    snapshot,
    vi.fn(),
    source ? { lcmStatus: () => source } : {},
  );
  dashboard.handleInput("3");
  return { dashboard, rendered: dashboard.render(width).join("\n") };
};

describe("Fabric dashboard LCM view", () => {
  it("renders coverage, node rows and reads the ledger once per refresh", () => {
    const { source, calls } = stub({
      nodes: [
        node({ nodeId: "node-root", children: ["node-child"], sources: [
          { sessionId: "session-1", entryId: "entry-1", revision: 1, payloadHash: "hash-1" },
        ] }),
        node({ nodeId: "node-child", kind: "leaf", depth: 1, text: "leaf text" }),
      ],
    });
    const { dashboard, rendered } = openLcm(source);
    try {
      expect(rendered).toContain("Fabric · LCM");
      expect(rendered).not.toContain("skipped as oversized");
      expect(rendered).toContain("10/40 covered 25%");
      expect(rendered).toContain("condensed model · 1 src · 1 ch");
      expect(rendered).toContain("leaf model");
      expect(rendered).toContain("session session-1 · 5368 entries");
      expect(rendered).toContain("today 4/no limit calls");
      expect(rendered).not.toContain("Infinity");

      expect(calls.report).toHaveBeenCalledTimes(1);
      expect(calls.coverage).toHaveBeenCalledTimes(1);
      expect(calls.preview).toHaveBeenCalledTimes(1);
      expect(calls.coverageMap).toHaveBeenCalledTimes(1);
      expect(calls.nodes).toHaveBeenCalledTimes(1);
      expect(calls.nodes).toHaveBeenCalledWith(200, 0);

      dashboard.render(120);
      dashboard.handleInput("j");
      dashboard.render(120);
      expect(calls.report).toHaveBeenCalledTimes(1);
      expect(calls.nodes).toHaveBeenCalledTimes(1);
    } finally {
      dashboard.dispose();
    }
  });

  it("requests a bounded node page and pages with [ and ]", () => {
    const many = Array.from({ length: 350 }, (_value, index) =>
      node({ nodeId: `node-${index}` }),
    );
    const { source, calls } = stub({ nodes: many });
    const { dashboard } = openLcm(source);
    try {
      expect(calls.nodes).toHaveBeenCalledWith(200, 0);
      dashboard.handleInput("]");
      expect(calls.nodes).toHaveBeenLastCalledWith(200, 200);
      dashboard.handleInput("]");
      expect(calls.nodes).toHaveBeenCalledTimes(2);
      dashboard.handleInput("[");
      expect(calls.nodes).toHaveBeenLastCalledWith(200, 0);
    } finally {
      dashboard.dispose();
    }
  });

  it("distinguishes a deterministic excerpt node from a model-written node", () => {
    const { source } = stub({
      nodes: [
        node({ nodeId: "node-model", modelHash: "sha256:model" }),
        node({ nodeId: "node-excerpt", modelHash: "emergency" }),
      ],
    });
    const { dashboard, rendered } = openLcm(source);
    try {
      const modelRow = rendered.split("\n").find((line) => line.includes("node-model"));
      const excerptRow = rendered.split("\n").find((line) => line.includes("node-excer"));
      expect(modelRow).toBeDefined();
      expect(excerptRow).toBeDefined();
      expect(modelRow).toContain("condensed model");
      expect(excerptRow).toContain("condensed excerpt");
      expect(excerptRow).not.toContain("condensed model");
    } finally {
      dashboard.dispose();
    }
  });

  it("states frontier and session payload separately and withholds a ratio while coverage is partial", () => {
    const { source } = stub({ coverage: { active: 5_368, covered: 15 } });
    const { dashboard, rendered } = openLcm(source, 200);
    try {
      expect(rendered).toContain("15/5368 covered 0.3%");
      const previewLine = rendered.split("\n").find((line) => line.includes("frontier holds"));
      expect(previewLine).toBeDefined();
      expect(previewLine).toContain("frontier holds 15/5368 sources");
      expect(previewLine).toContain("1.2 kB");
      expect(previewLine).toContain("session stored payload 4.5 MB");
      expect(previewLine).not.toContain("%");
      expect(rendered).toContain("assembled frontier text");
    } finally {
      dashboard.dispose();
    }
  });

  it("reports a compression figure once the frontier covers the session", () => {
    const { source } = stub({
      coverage: { active: 40, covered: 40 },
      preview: {
        text: "assembled frontier text",
        nodes: 3,
        summaryBytes: 500,
        sourceBytes: 2_000,
        coveredSources: 40,
        activeSources: 40,
      },
    });
    const { dashboard, rendered } = openLcm(source, 200);
    try {
      const previewLine = rendered.split("\n").find((line) => line.includes("frontier holds"));
      expect(previewLine).toContain("frontier holds 40/40 sources");
      expect(previewLine).toContain("assembled text is 25% of the session payload it replaces");
    } finally {
      dashboard.dispose();
    }
  });

  it("labels the previous and current revision of a node that was rewritten", () => {
    const selected = node({
      nodeId: "node-root",
      modelHash: "sha256:model",
      children: ["node-child"],
      sources: [
        { sessionId: "session-1", entryId: "entry-1", revision: 1, payloadHash: "hash-1" },
        { sessionId: "session-1", entryId: "entry-2", revision: 1, payloadHash: "hash-2" },
      ],
    });
    const { source, calls } = stub({
      nodes: [selected],
      detail: {
        node: selected,
        revisions: [
          { revision: 2, text: "model rewrote this", modelHash: "sha256:model", createdAt: NOW },
          { revision: 1, text: "deterministic excerpt", modelHash: "emergency", createdAt: NOW - 10 },
        ],
        ancestors: ["node-grandparent", "node-parent"],
      },
      entry: {
        payloadJson: '{"role":"user","content":"original text"}',
        content: "original text",
        role: "user",
        createdAt: NOW - 20,
      },
    });
    const { dashboard, rendered } = openLcm(source);
    try {
      expect(rendered).not.toContain("deterministic excerpt");
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      expect(calls.node).toHaveBeenCalledWith("node-root");
      expect(detail).toContain("previous revision 1 · excerpt");
      expect(detail).toContain("current revision 2 · model");
      expect(detail).toContain("deterministic excerpt");
      expect(detail).toContain("model rewrote this");
      expect(detail).toContain("node-grandparent › node-parent");
      expect(detail).toContain("session-1/entry-1@1");
      expect(detail).toContain("session-1/entry-2@1");

      dashboard.handleInput("j");
      dashboard.handleInput("\r");
      const raw = dashboard.render(120).join("\n");
      expect(calls.source).toHaveBeenCalledWith("session-1", "entry-2", 1);
      expect(raw).toContain("raw entry · user");
      expect(raw).toContain("original text");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("\x1b");
      expect(dashboard.render(120).join("\n")).toContain("frontier holds");
    } finally {
      dashboard.dispose();
    }
  });

  it("never prints healthy beside a fault while keeping the ledger fact readable", () => {
    const faulted = report({ ledgerState: "healthy", degraded: "LCM session reconciliation reported 1 error(s)" });

    expect(faulted.state).toBe("degraded");
    expect(faulted.ledgerState).toBe("healthy");
    expect(lcmStatusLabel(faulted)).toBe("degraded (ledger healthy)");

    const line = lcmStatusLine(faulted);
    expect(line).not.toContain("lcm · healthy");
    expect(line).toContain("degraded (ledger healthy)");
    expect(line).toContain("reported 1 error(s)");

    const { source } = stub({ report: { ledgerState: "healthy", degraded: "LCM session reconciliation reported 1 error(s)" } });
    const { dashboard, rendered } = openLcm(source, 200);
    try {
      const unwrapped = rendered.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
      expect(unwrapped).toContain("degraded (ledger healthy)");
      expect(unwrapped).toContain("reported 1 error(s)");
      expect(unwrapped).not.toMatch(/(?<!\(ledger )healthy/);
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps a healthy ledger word when nothing faulted", () => {
    const clean = report();

    expect(clean.state).toBe("healthy");
    expect(lcmStatusLabel(clean)).toBe("healthy");
    expect(lcmStatusLine(clean)).toContain("compaction: lcm · healthy · model");
    expect(lcmStatusLine(clean)).not.toContain("fault:");
  });

  it("names the raced reads reconciliation retried without calling them a fault", () => {
    const { source } = stub({
      report: {
        reconciliation: {
          degraded: false,
          errors: 0,
          raced: 2,
          drops: { oversizedFiles: 0, oversizedFileBytes: 0, oversizedLines: 0, oversizedLineBytes: 0, skippedFiles: 0, entries: 0 },
          reasons: [],
        },
      },
    });
    const { dashboard, rendered } = openLcm(source, 200);
    try {
      const unwrapped = rendered.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
      expect(unwrapped).toContain("reconciliation retried 2 raced reads");
      expect(unwrapped).toContain("healthy");
      expect(unwrapped).not.toContain("fault");
    } finally {
      dashboard.dispose();
    }
  });

  it("names what reconciliation dropped from the immutable store", () => {
    const { source } = stub({
      report: {
        reconciliation: {
          degraded: true,
          errors: 0,
          raced: 0,
          drops: {
            oversizedFiles: 2,
            oversizedFileBytes: 3_500_000,
            oversizedLines: 0,
            oversizedLineBytes: 0,
            skippedFiles: 0,
            entries: 0,
          },
          reasons: migrationDropReasons({
            oversizedFiles: 2,
            oversizedFileBytes: 3_500_000,
            oversizedLines: 0,
            oversizedLineBytes: 0,
            skippedFiles: 0,
            entries: 0,
          }),
        },
      },
    });
    const { dashboard, rendered } = openLcm(source, 200);
    try {
      const unwrapped = rendered.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
      expect(unwrapped).toContain("2 session files skipped as oversized (3.3 MB)");
    } finally {
      dashboard.dispose();
    }
  });

  it("explains itself instead of drawing an empty frame when the ledger is absent", () => {
    const withoutCapability = openLcm(undefined);
    try {
      expect(withoutCapability.rendered).toContain("LCM ledger unavailable");
      expect(withoutCapability.rendered).toContain("compaction.engine to lcm");
    } finally {
      withoutCapability.dashboard.dispose();
    }

    const closed = openLcm(undefined);
    const dashboard = new FabricDashboard(tui(), theme, snapshot, vi.fn(), {
      lcmStatus: () => undefined,
    });
    try {
      dashboard.handleInput("3");
      expect(dashboard.render(120).join("\n")).toContain("LCM ledger unavailable");
    } finally {
      dashboard.dispose();
      closed.dashboard.dispose();
    }
  });

  it("documents the view and its keys in the dashboard help", () => {
    const { source } = stub();
    const { dashboard } = openLcm(source);
    try {
      dashboard.handleInput("?");
      const help = dashboard.render(120).join("\n");
      expect(help).toContain("3 LCM ledger");
      expect(help).toContain("[ ] page 200 nodes");
      expect(help).toContain("enter inspect node");
    } finally {
      dashboard.dispose();
    }
  });

  it("advertises the LCM view from the views that can reach it", () => {
    const { source } = stub({});
    const dashboard = new FabricDashboard(tui(), theme, snapshot, vi.fn(), {
      lcmStatus: () => source,
    });
    expect(dashboard.render(160).join("\n")).toContain("3 lcm");

    dashboard.handleInput("2");
    expect(dashboard.render(160).join("\n")).toContain("3 lcm");
  });
});
