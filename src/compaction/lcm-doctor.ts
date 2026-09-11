export type LcmRepairId = "reconcile" | "readback" | "leases" | "jobs";

export type LcmCheckSeverity = "ok" | "info" | "warn" | "fail";

export interface LcmDiagnostics {
  projectKey: string;
  ledgerPath: string;
  ledgerBytes: number;
  ledgerState: string;
  runtimeError: string | undefined;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  sessionFilePresent: boolean;
  liveBranchEntries: number;
  ledgerSessionEntries: number;
  ledgerEntries: number;
  activeSources: number;
  coveredSources: number;
  backlogThreshold: number;
  pendingNodes: number;
  pendingJobs: number;
  runningJobs: number;
  failedJobs: number;
  expiredLeases: number;
  modelSummaries: boolean;
  summaryModel: string | undefined;
  budgetCalls: number;
  usedCalls: number;
  withinBudget: boolean;
  reconciliation: {
    errors: number;
    raced: number;
    absent: number;
    reasons: readonly string[];
  } | undefined;
  repairs: readonly LcmRepairOutcome[];
  autoRepairs: readonly LcmAutoRepair[];
}

export interface LcmAutoRepair {
  fault: string;
  attempts: number;
  nextAt: number;
  detail: string;
}

export interface LcmRepairOutcome {
  id: LcmRepairId;
  changed: boolean;
  detail: string;
  at: number;
}

export interface LcmCheck {
  id: string;
  title: string;
  severity: LcmCheckSeverity;
  detail: string;
  repair?: LcmRepairId;
}

const SEVERITY_ORDER: Record<LcmCheckSeverity, number> = { ok: 0, info: 1, warn: 2, fail: 3 };

export const worstSeverity = (checks: readonly LcmCheck[]): LcmCheckSeverity =>
  checks.reduce<LcmCheckSeverity>(
    (worst, check) => (SEVERITY_ORDER[check.severity] > SEVERITY_ORDER[worst] ? check.severity : worst),
    "ok",
  );

export const REPAIR_LABELS: Record<LcmRepairId, string> = {
  reconcile: "re-read the session file into the ledger",
  readback: "import the live branch into the ledger",
  leases: "release expired maintenance leases",
  jobs: "requeue failed maintenance jobs",
};

const megabytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

const percent = (part: number, whole: number): string =>
  whole <= 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;

/** Every check names the evidence it read, so a verdict is never a bare adjective. */
export const lcmChecks = (diagnostics: LcmDiagnostics): LcmCheck[] => {
  const checks: LcmCheck[] = [];

  const size = `${megabytes(diagnostics.ledgerBytes)} · ${diagnostics.ledgerEntries} entries`;
  checks.push(
    diagnostics.ledgerState === "degraded"
      ? { id: "ledger", title: "ledger", severity: "fail", detail: `unusable · ${diagnostics.ledgerPath}` }
      : diagnostics.ledgerState !== "healthy"
        ? { id: "ledger", title: "ledger", severity: "warn", detail: `${diagnostics.ledgerState} · ${size}` }
        : { id: "ledger", title: "ledger", severity: "ok", detail: `healthy · ${size}` },
  );

  if (diagnostics.runtimeError) {
    checks.push({ id: "runtime", title: "runtime", severity: "fail", detail: diagnostics.runtimeError, repair: "readback" });
  }

  checks.push(
    diagnostics.sessionId === undefined
      ? { id: "session", title: "session", severity: "info", detail: "no session selected yet" }
      : diagnostics.sessionFile === undefined
        ? { id: "session", title: "session", severity: "info", detail: `${diagnostics.sessionId} · this session is not persisted to disk` }
        : diagnostics.sessionFilePresent
          ? { id: "session", title: "session", severity: "ok", detail: `${diagnostics.sessionId} · file on disk` }
          : { id: "session", title: "session", severity: "info", detail: `${diagnostics.sessionId} · file not written yet; the branch is still in memory` },
  );

  const behind = diagnostics.liveBranchEntries - diagnostics.ledgerSessionEntries;
  checks.push(
    diagnostics.liveBranchEntries === 0
      ? { id: "readback", title: "readback", severity: "info", detail: "the live branch is empty" }
      : behind > 0
        ? { id: "readback", title: "readback", severity: "info", detail: `${behind} live entr${behind === 1 ? "y" : "ies"} land at the next turn boundary (${diagnostics.ledgerSessionEntries}/${diagnostics.liveBranchEntries} stored)`, repair: "readback" }
        : { id: "readback", title: "readback", severity: "ok", detail: `all ${diagnostics.liveBranchEntries} branch entries stored · ${diagnostics.ledgerSessionEntries} kept for this session` },
  );

  const reconciliation = diagnostics.reconciliation;
  checks.push(
    reconciliation === undefined
      ? { id: "reconcile", title: "reconcile", severity: "info", detail: "not run in this session yet" }
      : reconciliation.errors > 0
        ? { id: "reconcile", title: "reconcile", severity: "fail", detail: `${reconciliation.errors} unreadable session file(s)`, repair: "reconcile" }
        : reconciliation.reasons.length > 0
          ? { id: "reconcile", title: "reconcile", severity: "warn", detail: reconciliation.reasons.join("; "), repair: "reconcile" }
          : reconciliation.absent > 0
            ? { id: "reconcile", title: "reconcile", severity: "info", detail: "session file is not on disk yet; nothing to re-read" }
            : { id: "reconcile", title: "reconcile", severity: "ok", detail: reconciliation.raced > 0 ? `clean after ${reconciliation.raced} raced read(s)` : "clean" },
  );

  const uncovered = diagnostics.activeSources - diagnostics.coveredSources;
  checks.push(
    diagnostics.activeSources === 0
      ? { id: "coverage", title: "coverage", severity: "info", detail: "no active sources to cover yet" }
      : uncovered === 0
        ? { id: "coverage", title: "coverage", severity: "ok", detail: `${diagnostics.coveredSources}/${diagnostics.activeSources} sources held by ready nodes` }
        : diagnostics.pendingJobs + diagnostics.runningJobs > 0
          ? { id: "coverage", title: "coverage", severity: "info", detail: `${uncovered} source(s) uncovered · ${diagnostics.pendingJobs + diagnostics.runningJobs} job(s) already queued` }
          : uncovered >= diagnostics.backlogThreshold
            ? { id: "coverage", title: "coverage", severity: "warn", detail: `${uncovered} source(s) past the ${diagnostics.backlogThreshold}-entry backlog with no job queued (${percent(diagnostics.coveredSources, diagnostics.activeSources)} covered)` }
            : { id: "coverage", title: "coverage", severity: "info", detail: `${uncovered} source(s) uncovered · below the ${diagnostics.backlogThreshold}-entry backlog that starts a summary` },
  );

  checks.push(
    diagnostics.failedJobs > 0
      ? { id: "jobs", title: "jobs", severity: "warn", detail: `${diagnostics.failedJobs} failed · ${diagnostics.pendingJobs} pending · ${diagnostics.runningJobs} running`, repair: "jobs" }
      : diagnostics.expiredLeases > 0
        ? { id: "jobs", title: "jobs", severity: "warn", detail: `${diagnostics.expiredLeases} expired lease(s) still marked running`, repair: "leases" }
        : { id: "jobs", title: "jobs", severity: "ok", detail: `${diagnostics.pendingJobs} pending · ${diagnostics.runningJobs} running · ${diagnostics.pendingNodes} node(s) awaiting text` },
  );

  checks.push(
    !diagnostics.modelSummaries
      ? { id: "model", title: "model", severity: "info", detail: "model summaries are off; compaction serves deterministic excerpts" }
      : !diagnostics.withinBudget
        ? { id: "model", title: "model", severity: "warn", detail: `budget exhausted · ${diagnostics.usedCalls}/${Number.isFinite(diagnostics.budgetCalls) ? diagnostics.budgetCalls : "no limit"} calls today` }
        : { id: "model", title: "model", severity: "ok", detail: `${diagnostics.summaryModel || "inherit"} · ${diagnostics.usedCalls} call(s) today` },
  );

  return checks;
};
