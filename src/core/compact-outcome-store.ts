import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveAgentDir } from "./agent-dir.js";
import type { CompactLastCommit, CompactOutcomeStore } from "./compact-controller.js";

const OUTCOME_DIR = ["fabric", "compact"];
const MAX_OUTCOME_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const sessionFileName = (sessionId: string): string | undefined => {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
  return safe.length > 0 && safe.length <= 128 ? `${safe}.json` : undefined;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const decodeOutcome = (raw: unknown): CompactLastCommit | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const at = finiteNumber(record.at);
  const requestedBy = nonEmptyString(record.requestedBy);
  const status = record.status;
  if (at === undefined || requestedBy === undefined) return undefined;
  if (status !== "committed" && status !== "cancelled" && status !== "failed" && status !== "skipped") {
    return undefined;
  }
  const summary = nonEmptyString(record.summary);
  const error = nonEmptyString(record.error);
  const tokensBefore = finiteNumber(record.tokensBefore);
  const estimatedTokensAfter = finiteNumber(record.estimatedTokensAfter);
  return {
    at,
    requestedBy,
    status,
    ...(summary !== undefined ? { summary } : {}),
    ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    ...(estimatedTokensAfter !== undefined ? { estimatedTokensAfter } : {}),
    ...(error !== undefined ? { error } : {}),
    persisted: true,
  };
};

const pruneStale = (dir: string, now: number): void => {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const target = path.join(dir, entry);
    try {
      if (now - statSync(target).mtimeMs > MAX_OUTCOME_AGE_MS) rmSync(target, { force: true });
    } catch {
      continue;
    }
  }
};

export const fileCompactOutcomeStore = (
  agentDir: () => string = resolveAgentDir,
): CompactOutcomeStore => ({
  load(sessionId) {
    const name = sessionFileName(sessionId);
    if (name === undefined) return undefined;
    try {
      return decodeOutcome(JSON.parse(readFileSync(path.join(agentDir(), ...OUTCOME_DIR, name), "utf8")));
    } catch {
      return undefined;
    }
  },
  save(sessionId, outcome) {
    const name = sessionFileName(sessionId);
    if (name === undefined) return;
    try {
      const dir = path.join(agentDir(), ...OUTCOME_DIR);
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      const staging = `${target}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(outcome), "utf8");
      renameSync(staging, target);
      pruneStale(dir, Date.now());
    } catch {
      return;
    }
  },
});
