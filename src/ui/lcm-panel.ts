import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { LcmDashboardNode, LcmStatusSource } from "../fabric-runtime-state.js";
import { formatClock, formatCost, padToWidth, safeText, wrapPlainText } from "./format.js";

export const LCM_NODE_PAGE = 200;

const COVERAGE_COMPLETE_RATIO = 0.95;
const EMERGENCY_MODEL_HASH = "emergency";

export interface LcmViewSnapshot {
  report: ReturnType<LcmStatusSource["report"]>;
  coverage: ReturnType<LcmStatusSource["coverage"]>;
  preview: ReturnType<LcmStatusSource["preview"]>;
  coverageMap: ReturnType<LcmStatusSource["coverageMap"]>;
  nodes: LcmDashboardNode[];
  offset: number;
  hasMore: boolean;
}

export interface LcmNodeDetail {
  node: LcmDashboardNode;
  revisions: Array<{ revision: number; text: string; modelHash: string; createdAt: number }>;
  ancestors: string[];
}

export interface LcmSourceEntry {
  payloadJson: string;
  content: string;
  role: string;
  createdAt: number;
}

/** Reads every ledger projection the LCM view needs in one pass so rendering never walks the ledger. */
export const readLcmSnapshot = (source: LcmStatusSource, offset: number): LcmViewSnapshot => {
  const nodes = source.nodes(LCM_NODE_PAGE, offset);
  return {
    report: source.report(),
    coverage: source.coverage(),
    preview: source.preview(),
    coverageMap: source.coverageMap(),
    nodes,
    offset,
    hasMore: nodes.length === LCM_NODE_PAGE,
  };
};

export const lcmNodeDetail = (
  source: LcmStatusSource,
  nodeId: string,
): LcmNodeDetail | undefined => {
  const detail = source.node(nodeId);
  if (!detail) return undefined;
  return {
    node: detail.node,
    revisions: [...detail.revisions].sort((left, right) => left.revision - right.revision),
    ancestors: detail.ancestors,
  };
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} kB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
};

const formatBudget = (used: number, limit: number): string =>
  Number.isFinite(limit) ? `${used}/${limit}` : `${used}/no limit`;

const formatPercent = (value: number): string =>
  value > 0 && value < 1 ? `${value.toFixed(value < 0.1 ? 2 : 1)}%` : `${Math.round(value)}%`;

const isEmergency = (modelHash: string): boolean => modelHash === EMERGENCY_MODEL_HASH;

const originLabel = (modelHash: string): string => (isEmergency(modelHash) ? "excerpt" : "model");

const shortId = (value: string): string => (value.length > 10 ? `${value.slice(0, 10)}…` : value);

const textBytes = (text: string | undefined): number =>
  text ? Buffer.byteLength(text, "utf8") : 0;

export const lcmUnavailableLine = (): string =>
  "LCM ledger unavailable · set compaction.engine to lcm and start a session to populate it";

export const renderLcmHeaderLines = (
  theme: Theme,
  snapshot: LcmViewSnapshot,
  width: number,
): string[] => {
  const { report } = snapshot;
  const summary = [
    report.state,
    report.degraded ? `degraded ${report.degraded}` : undefined,
    `session ${report.sessionId ?? "none"} · ${report.sessionEntries} entries`,
    `ledger ${report.rawEntries} entries`,
    `model ${report.summaryModel || "inherit"}`,
    `${report.modelNodes} model · ${report.emergencyNodes} excerpt · ${report.pendingNodes} pending`,
    `today ${formatBudget(report.usage.calls, report.budget.calls)} calls · ${formatCost(report.usage.cost)}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return wrapPlainText(summary, width, 2).map((line) => theme.fg("dim", line));
};

const bandRun = (theme: Theme, char: string, length: number): string => {
  const color = char === "█" ? "success" : char === "▓" ? "warning" : "dim";
  return theme.fg(color, char.repeat(length));
};

const coverageBand = (
  theme: Theme,
  map: LcmViewSnapshot["coverageMap"],
  cells: number,
): string => {
  if (cells <= 0) return "";
  if (map.length === 0) return theme.fg("dim", "·".repeat(cells));
  let band = "";
  let runChar = "";
  let runLength = 0;
  for (let cell = 0; cell < cells; cell++) {
    const start = Math.min(map.length - 1, Math.floor((cell * map.length) / cells));
    const end = Math.min(map.length, Math.max(start + 1, Math.floor(((cell + 1) * map.length) / cells)));
    let covered = 0;
    for (let index = start; index < end; index++) {
      if (map[index]!.covered) covered++;
    }
    const char = covered === 0 ? "░" : covered === end - start ? "█" : "▓";
    if (char === runChar) {
      runLength++;
      continue;
    }
    if (runLength > 0) band += bandRun(theme, runChar, runLength);
    runChar = char;
    runLength = 1;
  }
  if (runLength > 0) band += bandRun(theme, runChar, runLength);
  return band;
};

export const renderLcmCoverageLine = (
  theme: Theme,
  snapshot: LcmViewSnapshot,
  width: number,
): string => {
  const { active, covered } = snapshot.coverage;
  const label = `${covered}/${active} covered ${formatPercent(active > 0 ? (covered / active) * 100 : 0)}`;
  const cells = Math.max(0, width - visibleWidth(label) - 1);
  const band = coverageBand(theme, snapshot.coverageMap, cells);
  return truncateToWidth(`${band} ${theme.fg("muted", label)}`, width, "");
};

const nodeRow = (node: LcmDashboardNode): string => {
  const indent = "  ".repeat(Math.min(node.depth, 8));
  const glyph = node.kind === "condensed" ? "◆" : "◇";
  return safeText(
    `${indent}${glyph} ${node.kind} ${originLabel(node.modelHash)} · ${node.sources.length} src · ${node.children.length} ch · ${formatBytes(textBytes(node.text))} · ${shortId(node.nodeId)}`,
  );
};

export const renderLcmNodeLines = (
  theme: Theme,
  snapshot: LcmViewSnapshot,
  width: number,
  height: number,
  selectedIndex: number,
): string[] => {
  const available = Math.max(1, height);
  const total = snapshot.nodes.length;
  const heading = `nodes ${total === 0 ? 0 : snapshot.offset + 1}-${snapshot.offset + total}${snapshot.hasMore ? "+" : ""}`;
  const lines = [theme.fg("accent", truncateToWidth(heading, width, ""))];
  if (total === 0) {
    lines.push(theme.fg("dim", "  (no summary nodes on the active branch yet)"));
    while (lines.length < available) lines.push("");
    return lines.slice(0, available);
  }
  const rows = Math.max(1, available - 1);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(rows / 2), Math.max(0, total - rows)),
  );
  for (let index = start; index < Math.min(total, start + rows); index++) {
    const node = snapshot.nodes[index]!;
    const emergency = isEmergency(node.modelHash);
    let line = theme.fg(emergency ? "warning" : "muted", nodeRow(node));
    if (index === selectedIndex) line = theme.bg("selectedBg", padToWidth(line, width));
    lines.push(truncateToWidth(line, width, ""));
  }
  while (lines.length < available) lines.push("");
  return lines.slice(0, available);
};

export const renderLcmPreviewLines = (
  theme: Theme,
  snapshot: LcmViewSnapshot,
  width: number,
  height: number,
): string[] => {
  const available = Math.max(1, height);
  const preview = snapshot.preview;
  const complete =
    preview.activeSources > 0 &&
    preview.coveredSources / preview.activeSources >= COVERAGE_COMPLETE_RATIO;
  const ratio =
    complete && preview.sourceBytes > 0
      ? ` · assembled text is ${formatPercent((preview.summaryBytes / preview.sourceBytes) * 100)} of the session payload it replaces`
      : "";
  const headline = `preview · frontier holds ${preview.coveredSources}/${preview.activeSources} sources · ${preview.nodes} nodes assemble to ${formatBytes(preview.summaryBytes)} · session stored payload ${formatBytes(preview.sourceBytes)}${ratio}`;
  const lines = wrapPlainText(headline, width, 2).map((line) => theme.fg("accent", line));
  const body = wrapPlainText(preview.text, width, Math.max(1, available - lines.length));
  for (const line of body) lines.push(theme.fg("dim", line));
  if (body.length === 0) lines.push(theme.fg("dim", "(the frontier assembles no text yet)"));
  while (lines.length < available) lines.push("");
  return lines.slice(0, available);
};

const revisionColumns = (
  theme: Theme,
  detail: LcmNodeDetail,
  width: number,
  rows: number,
): string[] => {
  const current = detail.revisions[detail.revisions.length - 1];
  const previous = detail.revisions[detail.revisions.length - 2];
  if (!current) return [];
  if (!previous) {
    const lines = [theme.fg("accent", `text · current revision ${current.revision} · ${originLabel(current.modelHash)}`)];
    for (const line of wrapPlainText(current.text, width, Math.max(1, rows - 1))) {
      lines.push(theme.fg("dim", line));
    }
    return lines;
  }
  const label = (revision: { revision: number; modelHash: string }, name: string): string =>
    `${name} revision ${revision.revision} · ${originLabel(revision.modelHash)}`;
  if (width < 60) {
    const lines = [theme.fg("accent", label(current, "current"))];
    for (const line of wrapPlainText(current.text, width, Math.max(1, Math.floor((rows - 2) / 2)))) {
      lines.push(theme.fg("dim", line));
    }
    lines.push(theme.fg("accent", label(previous, "previous")));
    for (const line of wrapPlainText(previous.text, width, Math.max(1, Math.floor((rows - 2) / 2)))) {
      lines.push(theme.fg("muted", line));
    }
    return lines;
  }
  const columnWidth = Math.floor((width - 1) / 2);
  const body = Math.max(1, rows - 1);
  const previousBody = wrapPlainText(previous.text, columnWidth, body);
  const currentBody = wrapPlainText(current.text, columnWidth, body);
  const lines = [
    `${padToWidth(theme.fg("accent", label(previous, "previous")), columnWidth)}${theme.fg("borderMuted", "│")}${theme.fg("accent", label(current, "current"))}`,
  ];
  for (let index = 0; index < body; index++) {
    const left = previousBody[index];
    const right = currentBody[index];
    if (left === undefined && right === undefined) break;
    lines.push(
      `${padToWidth(theme.fg("muted", left ?? ""), columnWidth)}${theme.fg("borderMuted", "│")}${theme.fg("dim", right ?? "")}`,
    );
  }
  return lines;
};

export const renderLcmDetailLines = (
  theme: Theme,
  detail: LcmNodeDetail,
  sourceIndex: number,
  entry: LcmSourceEntry | undefined,
  width: number,
  height: number,
): string[] => {
  const available = Math.max(1, height);
  const node = detail.node;
  const lines: string[] = [
    theme.fg(
      isEmergency(node.modelHash) ? "warning" : "accent",
      truncateToWidth(
        safeText(
          `${node.kind} · ${originLabel(node.modelHash)} · depth ${node.depth} · ${node.state} · ${formatClock(node.createdAt)} · ${node.nodeId}`,
        ),
        width,
        "",
      ),
    ),
    theme.fg(
      "dim",
      truncateToWidth(safeText(`model hash ${node.modelHash} · branch ${node.branch ?? "none"}`), width, ""),
    ),
    theme.fg(
      "dim",
      truncateToWidth(
        safeText(`ancestors ${detail.ancestors.length > 0 ? detail.ancestors.join(" › ") : "none"}`),
        width,
        "",
      ),
    ),
    theme.fg(
      "dim",
      truncateToWidth(
        safeText(
          `children (${node.children.length}) ${node.children.length > 0 ? node.children.map(shortId).join(" ") : "none"}`,
        ),
        width,
        "",
      ),
    ),
    theme.fg("accent", truncateToWidth(`sources (${node.sources.length})`, width, "")),
  ];
  const sourceRows = Math.min(node.sources.length, Math.max(1, Math.floor(available / 4)));
  const sourceStart = Math.max(
    0,
    Math.min(sourceIndex - Math.floor(sourceRows / 2), Math.max(0, node.sources.length - sourceRows)),
  );
  for (let index = sourceStart; index < Math.min(node.sources.length, sourceStart + sourceRows); index++) {
    const source = node.sources[index]!;
    const text = `  ${source.sessionId}/${source.entryId}@${source.revision}`;
    const line =
      index === sourceIndex
        ? theme.bg("selectedBg", padToWidth(theme.fg("muted", text), width))
        : theme.fg("muted", text);
    lines.push(truncateToWidth(line, width, ""));
  }
  if (node.sources.length === 0) lines.push(theme.fg("dim", "  (no sources)"));
  if (entry) {
    lines.push(
      theme.fg(
        "accent",
        truncateToWidth(
          safeText(`raw entry · ${entry.role} · ${formatClock(entry.createdAt)} · ${formatBytes(Buffer.byteLength(entry.payloadJson, "utf8"))} stored`),
          width,
          "",
        ),
      ),
    );
    for (const line of wrapPlainText(entry.content, width, Math.max(1, Math.floor(available / 4)))) {
      lines.push(theme.fg("dim", line));
    }
  }
  const remaining = Math.max(1, available - lines.length);
  for (const line of revisionColumns(theme, detail, width, remaining)) lines.push(line);
  while (lines.length < available) lines.push("");
  return lines.slice(0, available);
};
