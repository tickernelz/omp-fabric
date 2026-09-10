import type { LcmReport } from "./lcm-runtime.js";

export const reconcileLcmState = (ledgerState: string, degraded: string | undefined): string =>
  degraded === undefined ? ledgerState : "degraded";

export const lcmStatusLabel = (report: Pick<LcmReport, "state" | "ledgerState">): string =>
  report.state === report.ledgerState ? report.state : `${report.state} (ledger ${report.ledgerState})`;

export const lcmStatusLine = (report: LcmReport): string => {
  const summaries = report.modelNodes + report.emergencyNodes;
  const model = report.summaryModel || "inherit";
  const calls = Number.isFinite(report.budget.calls) ? `${report.usage.calls}/${report.budget.calls}` : `${report.usage.calls}`;
  return `compaction: lcm · ${lcmStatusLabel(report)} · model ${model} · ${report.rawEntries} entries · ${summaries} nodes (${report.modelNodes} by model, ${report.emergencyNodes} excerpt) · today ${calls} calls, ${Math.round(report.usage.wallMs / 1000)}s${report.degraded ? ` · fault: ${report.degraded}` : ""}`;
};
