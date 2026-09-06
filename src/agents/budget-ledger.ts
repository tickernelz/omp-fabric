import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process cost budget ledger for a Fabric recursion tree.
 *
 * A recursion tree spans one OMP process per node. Each node's AgentManager
 * records the cost of the children it spawns into a single append-only JSONL
 * file, and checks the accumulated spend before spawning another child. The
 * ledger path and budget travel to descendants through OMP_FABRIC_BUDGET*
 * environment variables, which the worker forwards to child OMP processes via
 * `{ ...process.env }`.
 *
 * This mirrors ypi's RLM_BUDGET / RLM_COST_FILE model: the check is best-effort
 * (concurrent children can each pass the check before any cost lands, so a tree
 * may slightly overshoot), while the race-free ceiling remains the per-execution
 * call count (agents.maxPerExecution). Cost is recorded only after a child
 * finishes, matching ypi's append-after-completion semantics.
 */

export interface BudgetLedgerEntry {
  id: string;
  depth: number;
  cost: number;
  tokens: number;
  ts: number;
  runner?: string;
  actorId?: string;
  actorName?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface BudgetLedgerSummary {
  cost: number;
  tokens: number;
}

export interface BudgetLedgerDetail {
  cost: number;
  tokens: number;
  byRunner: Record<string, { cost: number; tokens: number }>;
  byActor: Record<string, { cost: number; tokens: number }>;
  entries: BudgetLedgerEntry[];
}

export interface BudgetLedgerState {
  budget: number;
  file: string;
  id: string;
}

const ENV_BUDGET = "OMP_FABRIC_BUDGET";
const ENV_BUDGET_FILE = "OMP_FABRIC_BUDGET_FILE";
const ENV_BUDGET_ID = "OMP_FABRIC_BUDGET_ID";

const parseFloatFinite = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Read the active budget state inherited from the recursion-tree root.
 * Returns undefined when no budget is active for this process.
 */
export function activeBudgetState(): BudgetLedgerState | undefined {
  const file = process.env[ENV_BUDGET_FILE];
  const budget = parseFloatFinite(process.env[ENV_BUDGET]);
  if (!file || budget === undefined || budget <= 0) return undefined;
  return { budget, file, id: process.env[ENV_BUDGET_ID] ?? "" };
}

/**
 * Initialize a shared ledger for a recursion tree and seed the environment
 * variables that descendants inherit. Only call at the tree root (depth 0)
 * when no budget has been inherited and a positive budget is configured.
 */
export function initBudgetLedger(budget: number): BudgetLedgerState {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-budget-"));
  const file = path.join(directory, "cost.jsonl");
  fs.writeFileSync(file, "", { mode: 0o600 });
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  process.env[ENV_BUDGET] = String(budget);
  process.env[ENV_BUDGET_FILE] = file;
  process.env[ENV_BUDGET_ID] = id;
  return { budget, file, id };
}

/**
 * Clear the budget environment variables seeded by initBudgetLedger. Called by
 * the owning (depth-0) manager on close so a long-lived host process does not
 * leak an active budget into a later, unrelated session.
 */
export function useBudgetLedger(state: BudgetLedgerState): void {
  process.env[ENV_BUDGET] = String(state.budget);
  process.env[ENV_BUDGET_FILE] = state.file;
  process.env[ENV_BUDGET_ID] = state.id;
}

export function clearOwnedBudgetEnv(): void {
  delete process.env[ENV_BUDGET];
  delete process.env[ENV_BUDGET_FILE];
  delete process.env[ENV_BUDGET_ID];
}

/**
 * Sum the append-only ledger. Malformed lines are tolerated, matching ypi's
 * rlm_cost parser: a single bad entry must not abort the whole read.
 */
export function readBudgetLedger(file: string): BudgetLedgerSummary {
  let cost = 0;
  let tokens = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { cost, tokens };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<BudgetLedgerEntry>;
      cost += Number(parsed.cost) || 0;
      tokens += Number(parsed.tokens) || 0;
    } catch {
      // Ignore malformed cost lines; the ledger is best-effort.
    }
  }
  return { cost, tokens };
}

/**
 * Append a child's incurred cost to the shared ledger. O_APPEND makes small
 * single-line writes atomic across concurrent writers on POSIX, which is
 * sufficient because each manager appends one entry after a child settles.
 */
export function appendBudgetLedger(file: string, entry: BudgetLedgerEntry): void {
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A ledger write failure must not break the agent run; the next check
    // still guards against runaway spend via the per-execution call ceiling.
  }
}

/**
 * Parse a ledger entry, accepting legacy flat rows ({id,depth,cost,tokens,ts})
 * while validating the optional attribution fields added for token telemetry.
 */
const parseBudgetLedgerEntry = (value: unknown): BudgetLedgerEntry | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.cost !== "number" ||
    typeof candidate.tokens !== "number" ||
    typeof candidate.ts !== "number"
  ) {
    return undefined;
  }
  return candidate as unknown as BudgetLedgerEntry;
};

/**
 * Sum the append-only ledger with full per-attribution breakdown. Reuses the
 * tolerant line-parsing semantics of readBudgetLedger while exposing runner/
 * actor/token-kind rollups for orchestrator decisions.
 */
export function readBudgetLedgerDetailed(file: string): BudgetLedgerDetail {
  const detail: BudgetLedgerDetail = {
    cost: 0,
    tokens: 0,
    byRunner: {},
    byActor: {},
    entries: [],
  };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return detail;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = parseBudgetLedgerEntry(JSON.parse(line));
      if (!entry) continue;
      detail.cost += Number(entry.cost) || 0;
      detail.tokens += Number(entry.tokens) || 0;
      detail.entries.push(entry);
      const runnerKey = entry.runner ?? "unknown";
      const runnerRollup = (detail.byRunner[runnerKey] ??= { cost: 0, tokens: 0 });
      runnerRollup.cost += entry.cost;
      runnerRollup.tokens += entry.tokens;
      if (entry.actorId) {
        const actorRollup = (detail.byActor[entry.actorId] ??= { cost: 0, tokens: 0 });
        actorRollup.cost += entry.cost;
        actorRollup.tokens += entry.tokens;
      }
    } catch {
      // Ignore malformed cost lines; the ledger is best-effort.
    }
  }
  return detail;
}
