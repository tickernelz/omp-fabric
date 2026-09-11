import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { Component, Focusable, TUI } from "@oh-my-pi/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import {
  lcmChecks,
  REPAIR_LABELS,
  worstSeverity,
  type LcmCheck,
  type LcmCheckSeverity,
  type LcmDiagnostics,
  type LcmRepairId,
  type LcmRepairOutcome,
} from "../compaction/lcm-doctor.js";
import type { LcmDashboardJob, LcmStatusSource } from "../fabric-runtime-state.js";
import { bottomBorder, middleBorder, narrowFallback, row, topBorder } from "./frame.js";
import { formatClock, formatCost, padToWidth, safeText, wrapPlainText } from "./format.js";
import {
  lcmNodeDetail,
  lcmUnavailableLine,
  LCM_NODE_PAGE,
  readLcmSnapshot,
  renderLcmCoverageLine,
  renderLcmDetailLines,
  renderLcmNodeLines,
  renderLcmPreviewLines,
  type LcmNodeDetail,
  type LcmSourceEntry,
  type LcmViewSnapshot,
} from "./lcm-panel.js";

const REFRESH_MS = 1_000;
const MIN_WIDTH = 32;
const TABS = ["health", "graph", "coverage", "jobs"] as const;
type LcmTab = (typeof TABS)[number];

const SEVERITY_GLYPH: Record<LcmCheckSeverity, string> = { ok: "\u2713", info: "\u00b7", warn: "!", fail: "\u2717" };
const SEVERITY_COLOR: Record<LcmCheckSeverity, ThemeColor> = {
  ok: "success",
  info: "dim",
  warn: "warning",
  fail: "error",
};
const SEVERITY_WORD: Record<LcmCheckSeverity, string> = {
  ok: "healthy",
  info: "priming",
  warn: "attention",
  fail: "degraded",
};
const AUTO_REPAIR_ATTEMPTS = 5;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1_024) return Math.round(bytes) + " B";
  if (bytes < 1_048_576) return (bytes / 1_024).toFixed(1) + " kB";
  return (bytes / 1_048_576).toFixed(1) + " MB";
};

const relative = (at: number, now: number): string => {
  const delta = Math.round((at - now) / 1_000);
  if (delta <= 0) return "now";
  if (delta < 60) return delta + "s";
  return Math.round(delta / 60) + "m";
};

export class FabricLcmDashboard implements Component, Focusable {
  focused = false;
  private tab: LcmTab = "health";
  private snapshot: LcmViewSnapshot | undefined;
  private diagnostics: LcmDiagnostics | undefined;
  private checks: LcmCheck[] = [];
  private jobs: LcmDashboardJob[] = [];
  private checkIndex = 0;
  private nodeIndex = 0;
  private nodeOffset = 0;
  private detail: LcmNodeDetail | undefined;
  private sourceIndex = 0;
  private sourceEntry: LcmSourceEntry | undefined;
  private busy: LcmRepairId | undefined;
  private notice: string | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly source: () => LcmStatusSource | undefined,
    private readonly done: () => void,
  ) {
    this.refresh();
    this.timer = setInterval(() => {
      this.refresh();
      this.tui.requestRender();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  private refresh(): void {
    const source = this.source();
    if (!source) {
      this.snapshot = undefined;
      this.diagnostics = undefined;
      this.checks = [];
      this.jobs = [];
      return;
    }
    this.snapshot = readLcmSnapshot(source, this.nodeOffset);
    this.diagnostics = source.diagnostics(this.snapshot.report);
    this.checks = lcmChecks(this.diagnostics);
    this.jobs = source.jobs(LCM_NODE_PAGE);
    this.checkIndex = Math.max(0, Math.min(this.checkIndex, Math.max(0, this.checks.length - 1)));
    this.nodeIndex = Math.max(0, Math.min(this.nodeIndex, Math.max(0, this.snapshot.nodes.length - 1)));
  }

  private runRepair(id: LcmRepairId): void {
    const source = this.source();
    if (!source) return;
    if (this.busy) {
      this.notice = REPAIR_LABELS[this.busy] + " is still running";
      return;
    }
    this.busy = id;
    this.notice = REPAIR_LABELS[id] + "\u2026";
    this.tui.requestRender();
    void source
      .repair(id)
      .then((outcome: LcmRepairOutcome) => {
        this.notice = (outcome.changed ? "repaired" : "no change") + " \u00b7 " + outcome.detail;
      })
      .catch((error: unknown) => {
        this.notice = "repair failed \u00b7 " + (error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.busy = undefined;
        this.refresh();
        this.tui.requestRender();
      });
  }

  private openNode(): void {
    const nodeId = this.snapshot?.nodes[this.nodeIndex]?.nodeId;
    const source = nodeId ? this.source() : undefined;
    this.detail = source && nodeId ? lcmNodeDetail(source, nodeId) : undefined;
    this.sourceIndex = 0;
    this.sourceEntry = undefined;
  }

  private openSource(): void {
    const selected = this.detail?.node.sources[this.sourceIndex];
    if (!selected) return;
    if (this.sourceEntry) {
      this.sourceEntry = undefined;
      return;
    }
    this.sourceEntry = this.source()?.source(selected.sessionId, selected.entryId, selected.revision);
  }

  private pageNodes(direction: -1 | 1): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    if (direction === 1 && !snapshot.hasMore) return;
    const next = Math.max(0, snapshot.offset + direction * LCM_NODE_PAGE);
    if (next === snapshot.offset) return;
    this.nodeOffset = next;
    this.nodeIndex = 0;
    this.refresh();
  }

  handleInput(data: string): void {
    const tabIndex = TABS.findIndex((_, index) => data === String(index + 1));
    if (tabIndex >= 0) {
      this.tab = TABS[tabIndex]!;
      this.detail = undefined;
      this.notice = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.detail) {
        if (this.sourceEntry) this.sourceEntry = undefined;
        else this.detail = undefined;
        this.tui.requestRender();
        return;
      }
      this.done();
      return;
    }
    const up = matchesKey(data, Key.up) || data === "k";
    const down = matchesKey(data, Key.down) || data === "j";
    if (this.detail) {
      const sources = this.detail.node.sources.length;
      if (up) {
        this.sourceIndex = Math.max(0, this.sourceIndex - 1);
        this.sourceEntry = undefined;
      } else if (down) {
        this.sourceIndex = Math.min(Math.max(0, sources - 1), this.sourceIndex + 1);
        this.sourceEntry = undefined;
      } else if (matchesKey(data, Key.enter)) {
        this.openSource();
      } else if (matchesKey(data, Key.left) || data === "h") {
        this.detail = undefined;
      }
      this.tui.requestRender();
      return;
    }
    if (this.tab === "health") {
      if (up) this.checkIndex = Math.max(0, this.checkIndex - 1);
      else if (down) this.checkIndex = Math.min(Math.max(0, this.checks.length - 1), this.checkIndex + 1);
      else if (data === "r") {
        const repair = this.checks[this.checkIndex]?.repair;
        if (repair) this.runRepair(repair);
        else this.notice = "this check has no repair";
      } else if (data === "R") {
        const pending = this.checks.find((check) => check.repair !== undefined);
        if (pending?.repair) this.runRepair(pending.repair);
        else this.notice = "nothing to repair";
      }
    } else if (this.tab === "graph") {
      const total = this.snapshot?.nodes.length ?? 0;
      if (up) this.nodeIndex = Math.max(0, this.nodeIndex - 1);
      else if (down) this.nodeIndex = Math.min(Math.max(0, total - 1), this.nodeIndex + 1);
      else if (data === "g") this.nodeIndex = 0;
      else if (data === "G") this.nodeIndex = Math.max(0, total - 1);
      else if (data === "[") this.pageNodes(-1);
      else if (data === "]") this.pageNodes(1);
      else if (matchesKey(data, Key.enter)) this.openNode();
    } else if (this.tab === "jobs") {
      if (data === "r") this.runRepair("jobs");
      else if (data === "l") this.runRepair("leases");
    }
    this.tui.requestRender();
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (width < MIN_WIDTH) return narrowFallback(width, "Fabric \u00b7 LCM", "esc close");
    const inner = width - 2;
    const lines = [topBorder(this.theme, width, "Fabric \u00b7 LCM")];
    const snapshot = this.snapshot;
    const diagnostics = this.diagnostics;
    if (!snapshot || !diagnostics) {
      lines.push(row(this.theme, width, this.theme.fg("muted", lcmUnavailableLine())));
      lines.push(middleBorder(this.theme, width));
      lines.push(row(this.theme, width, this.theme.fg("dim", "esc close")));
      lines.push(bottomBorder(this.theme, width));
      return lines.map((line) => truncateToWidth(line, width, ""));
    }
    for (const line of this.headerLines(diagnostics, inner)) lines.push(row(this.theme, width, line));
    lines.push(row(this.theme, width, renderLcmCoverageLine(this.theme, snapshot, inner)));
    lines.push(middleBorder(this.theme, width));
    lines.push(row(this.theme, width, this.tabStrip(inner)));
    lines.push(middleBorder(this.theme, width));
    for (const line of this.bodyLines(snapshot, diagnostics, inner, this.bodyRows(lines.length))) {
      lines.push(row(this.theme, width, line));
    }
    lines.push(middleBorder(this.theme, width));
    lines.push(row(this.theme, width, this.theme.fg("dim", truncateToWidth(this.footer(), inner, ""))));
    lines.push(bottomBorder(this.theme, width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
    this.detail = undefined;
    this.sourceEntry = undefined;
  }

  private bodyRows(used: number): number {
    const terminal = Math.max(12, this.tui.terminal?.rows ?? 28);
    return Math.max(6, Math.min(40, Math.floor((terminal * 90) / 100) - used - 4));
  }

  private headerLines(diagnostics: LcmDiagnostics, width: number): string[] {
    const severity = worstSeverity(this.checks);
    const facts = [
      "session " + (diagnostics.sessionId ? diagnostics.sessionId.slice(0, 8) : "none"),
      diagnostics.liveBranchEntries + " live",
      diagnostics.ledgerSessionEntries + " stored",
      "ledger " + diagnostics.ledgerEntries,
      ...(diagnostics.summaryModel ? [diagnostics.summaryModel] : []),
      diagnostics.usedCalls + " calls",
      formatCost(this.snapshot?.report.usage.cost ?? 0),
    ].join(" \u00b7 ");
    const headline = [
      this.theme.fg(SEVERITY_COLOR[severity], SEVERITY_GLYPH[severity] + " " + SEVERITY_WORD[severity]),
      this.theme.fg("muted", diagnostics.projectKey),
      this.theme.fg("dim", facts),
    ].join(this.theme.fg("dim", " \u00b7 "));
    return wrapPlainText(headline, width, 2);
  }

  private tabStrip(width: number): string {
    const cells = TABS.map((tab, index) => {
      const label = " " + (index + 1) + " " + tab + " ";
      return tab === this.tab
        ? this.theme.bg("selectedBg", this.theme.fg("accent", label))
        : this.theme.fg("dim", label);
    });
    return truncateToWidth(cells.join(""), width, "");
  }

  private footer(): string {
    if (this.notice) return (this.busy ? "\u2026 " : "") + this.notice + " \u00b7 1-4 tab \u00b7 esc close";
    if (this.detail) {
      return "\u2191\u2193/jk source \u00b7 enter " + (this.sourceEntry ? "close" : "open") + " raw entry \u00b7 esc back";
    }
    if (this.tab === "health") return "\u2191\u2193/jk check \u00b7 r repair \u00b7 R repair first \u00b7 1-4 tab \u00b7 esc close";
    if (this.tab === "graph") return "\u2191\u2193/jk node \u00b7 g/G first/last \u00b7 [ ] page \u00b7 enter inspect \u00b7 1-4 tab \u00b7 esc close";
    if (this.tab === "jobs") return "r requeue failed \u00b7 l release leases \u00b7 1-4 tab \u00b7 esc close";
    return "1-4 tab \u00b7 esc close";
  }

  private bodyLines(
    snapshot: LcmViewSnapshot,
    diagnostics: LcmDiagnostics,
    width: number,
    rows: number,
  ): string[] {
    if (this.detail) {
      return renderLcmDetailLines(this.theme, this.detail, this.sourceIndex, this.sourceEntry, width, rows);
    }
    if (this.tab === "health") return this.healthLines(diagnostics, width, rows);
    if (this.tab === "graph") return renderLcmNodeLines(this.theme, snapshot, width, rows, this.nodeIndex);
    if (this.tab === "coverage") return this.coverageLines(snapshot, diagnostics, width, rows);
    return this.jobLines(diagnostics, width, rows);
  }

  private healthLines(diagnostics: LcmDiagnostics, width: number, rows: number): string[] {
    const lines: string[] = [];
    const titleWidth = Math.max(8, ...this.checks.map((check) => check.title.length));
    for (const [index, check] of this.checks.entries()) {
      const glyph = this.theme.fg(SEVERITY_COLOR[check.severity], SEVERITY_GLYPH[check.severity]);
      const title = this.theme.fg(
        check.severity === "ok" ? "muted" : SEVERITY_COLOR[check.severity],
        padToWidth(check.title, titleWidth),
      );
      const hint =
        index === this.checkIndex && check.repair
          ? this.theme.fg("accent", " \u00b7 r: " + REPAIR_LABELS[check.repair])
          : "";
      const text = glyph + " " + title + "  " + this.theme.fg("dim", safeText(check.detail)) + hint;
      lines.push(index === this.checkIndex ? this.theme.bg("selectedBg", padToWidth(text, width)) : text);
    }
    if (diagnostics.autoRepairs.length > 0 && lines.length + 2 < rows) {
      lines.push("");
      lines.push(this.theme.fg("accent", "auto-repair"));
      const now = Date.now();
      for (const auto of diagnostics.autoRepairs.slice(0, Math.max(1, rows - lines.length))) {
        const budget = auto.attempts >= AUTO_REPAIR_ATTEMPTS
          ? "parked after " + auto.attempts + " attempts"
          : "attempt " + auto.attempts + "/" + AUTO_REPAIR_ATTEMPTS + " \u00b7 next in " + relative(auto.nextAt, now);
        lines.push(this.theme.fg("dim", safeText("  " + auto.fault + " \u00b7 " + budget + " \u00b7 " + auto.detail)));
      }
    }
    if (diagnostics.repairs.length > 0 && lines.length + 2 < rows) {
      lines.push("");
      lines.push(this.theme.fg("accent", "repairs"));
      for (const repair of diagnostics.repairs.slice(0, Math.max(1, rows - lines.length))) {
        const detail =
          "  " + formatClock(repair.at) + "  " + repair.id + " \u00b7 " + (repair.changed ? "changed" : "no change") + " \u00b7 " + repair.detail;
        lines.push(this.theme.fg("dim", safeText(detail)));
      }
    }
    while (lines.length < rows) lines.push("");
    return lines.slice(0, rows);
  }

  private coverageLines(
    snapshot: LcmViewSnapshot,
    diagnostics: LcmDiagnostics,
    width: number,
    rows: number,
  ): string[] {
    const map = snapshot.coverageMap;
    const headline =
      map.length + " stored entries \u00b7 " + diagnostics.coveredSources + " held by ready nodes \u00b7 stored payload " +
      formatBytes(snapshot.preview.sourceBytes) + " \u00b7 frontier text " + formatBytes(snapshot.preview.summaryBytes);
    const lines: string[] = [this.theme.fg("accent", truncateToWidth(headline, width, ""))];
    if (map.length === 0) {
      lines.push(this.theme.fg("dim", "(no branch entries in the ledger yet)"));
    } else {
      const gridRows = Math.max(1, Math.min(6, Math.ceil(map.length / Math.max(1, width))));
      const cells = gridRows * width;
      for (let line = 0; line < gridRows; line++) {
        let text = "";
        for (let column = 0; column < width; column++) {
          const cell = line * width + column;
          const start = Math.min(map.length - 1, Math.floor((cell * map.length) / cells));
          const end = Math.min(map.length, Math.max(start + 1, Math.floor(((cell + 1) * map.length) / cells)));
          let covered = 0;
          for (let index = start; index < end; index++) if (map[index]!.covered) covered += 1;
          text += covered === 0 ? "\u2591" : covered === end - start ? "\u2588" : "\u2593";
        }
        lines.push(this.theme.fg("dim", text));
      }
    }
    lines.push("");
    for (const line of renderLcmPreviewLines(this.theme, snapshot, width, Math.max(2, rows - lines.length))) {
      lines.push(line);
    }
    while (lines.length < rows) lines.push("");
    return lines.slice(0, rows);
  }

  private jobLines(diagnostics: LcmDiagnostics, width: number, rows: number): string[] {
    const now = Date.now();
    const budget = Number.isFinite(diagnostics.budgetCalls) ? String(diagnostics.budgetCalls) : "no limit";
    const headline =
      diagnostics.pendingJobs + " pending \u00b7 " + diagnostics.runningJobs + " running \u00b7 " + diagnostics.failedJobs +
      " failed today \u00b7 " + diagnostics.expiredLeases + " expired lease(s) \u00b7 " + diagnostics.usedCalls + "/" + budget + " calls";
    const lines: string[] = [this.theme.fg("accent", truncateToWidth(headline, width, ""))];
    if (this.jobs.length === 0) lines.push(this.theme.fg("dim", "(no maintenance jobs recorded)"));
    for (const job of this.jobs.slice(0, Math.max(1, rows - lines.length))) {
      const color: ThemeColor =
        job.state === "failed" ? "error" : job.state === "running" ? "accent" : job.state === "completed" ? "dim" : "warning";
      const tail = job.error
        ? "\u00b7 " + job.error
        : job.state === "pending" && job.nextRetryAt > now
          ? "\u00b7 retry in " + relative(job.nextRetryAt, now)
          : "";
      const body = padToWidth(job.attempts + " try", 7) + " " + formatClock(job.updatedAt) + "  " + job.nodeId + " " + tail;
      lines.push(
        truncateToWidth(this.theme.fg(color, padToWidth(job.state, 9)) + this.theme.fg("dim", safeText(body)), width, ""),
      );
    }
    while (lines.length < rows) lines.push("");
    return lines.slice(0, rows);
  }
}
