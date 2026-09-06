import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";

export const FABRIC_RUN_ROOT_PREFIX = "omp-fabric-runs-";
const RUN_ROOT_OWNER_FILE = ".fabric-owner.json";
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "timed_out"]);

interface RunRootOwner {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  orphanedAt?: number;
  closedAt?: number;
}

interface RunRecordSummary {
  status?: string;
  actorId?: string;
  finishedAt?: number;
  updatedAt?: number;
}

export interface RetentionSweepResult {
  removedRoots: string[];
  removedRuns: string[];
}

const ownerPath = (root: string): string => path.join(root, RUN_ROOT_OWNER_FILE);

const readJson = <T>(filePath: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const writeOwner = (root: string, owner: RunRootOwner): void => {
  writeJsonAtomic(ownerPath(root), owner);
};

export const markRunRootActive = (root: string, now = Date.now()): void => {
  const existing = readJson<RunRootOwner>(ownerPath(root));
  writeOwner(root, {
    pid: process.pid,
    startedAt: existing?.startedAt ?? now,
    heartbeatAt: now,
  });
};

export const heartbeatRunRoot = (root: string, now = Date.now()): void => {
  markRunRootActive(root, now);
};

export const markRunRootClosed = (root: string, now = Date.now()): void => {
  const existing = readJson<RunRootOwner>(ownerPath(root));
  writeOwner(root, {
    pid: process.pid,
    startedAt: existing?.startedAt ?? now,
    heartbeatAt: now,
    closedAt: now,
  });
};

const recordAgeReference = (record: RunRecordSummary, fallback: number): number =>
  typeof record.finishedAt === "number"
    ? record.finishedAt
    : typeof record.updatedAt === "number"
      ? record.updatedAt
      : fallback;

const pruneClosedRunRoot = (
  root: string,
  orphanedTempRunRetentionMs: number,
  oneShotRunRetentionMs: number,
  now: number,
): string[] => {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDirectory = path.join(root, entry.name);
    const record = readJson<RunRecordSummary>(path.join(runDirectory, "status.json"));
    if (!record?.status || !TERMINAL_STATUSES.has(record.status)) continue;
    let fallback = now;
    try { fallback = fs.statSync(runDirectory).mtimeMs; } catch {}
    const retentionMs = record.actorId
      ? orphanedTempRunRetentionMs
      : oneShotRunRetentionMs;
    if (now - recordAgeReference(record, fallback) < retentionMs) continue;
    fs.rmSync(runDirectory, { recursive: true, force: true });
    removed.push(runDirectory);
  }
  return removed;
};

const removeIfEmpty = (root: string): boolean => {
  try {
    const remaining = fs.readdirSync(root).filter((name) => name !== RUN_ROOT_OWNER_FILE);
    if (remaining.length > 0) return false;
    fs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

export const sweepTempRunRoots = (options: {
  tempRoot: string;
  currentRoot?: string;
  orphanedTempRunRetentionMs: number;
  oneShotRunRetentionMs: number;
  now?: number;
}): RetentionSweepResult => {
  const now = options.now ?? Date.now();
  const result: RetentionSweepResult = { removedRoots: [], removedRuns: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(options.tempRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FABRIC_RUN_ROOT_PREFIX)) continue;
    const root = path.join(options.tempRoot, entry.name);
    if (options.currentRoot && path.resolve(root) === path.resolve(options.currentRoot)) continue;
    const owner = readJson<RunRootOwner>(ownerPath(root));
    if (!owner) {
      try {
        if (
          fs.readdirSync(root).length === 0 &&
          now - fs.statSync(root).mtimeMs >= options.orphanedTempRunRetentionMs
        ) {
          fs.rmSync(root, { recursive: true, force: true });
          result.removedRoots.push(root);
        }
      } catch {}
      continue;
    }
    if (typeof owner.closedAt === "number") {
      result.removedRuns.push(
        ...pruneClosedRunRoot(
          root,
          options.orphanedTempRunRetentionMs,
          options.oneShotRunRetentionMs,
          now,
        ),
      );
      if (removeIfEmpty(root)) result.removedRoots.push(root);
      continue;
    }
    if (processAlive(owner.pid)) continue;
    if (typeof owner.orphanedAt !== "number") {
      writeOwner(root, { ...owner, orphanedAt: now });
      continue;
    }
    if (now - owner.orphanedAt < options.orphanedTempRunRetentionMs) continue;
    fs.rmSync(root, { recursive: true, force: true });
    result.removedRoots.push(root);
  }
  return result;
};

export const pruneActorRunArchives = (options: {
  runsDirectory: string;
  latestRunId?: string;
  retentionMs: number;
  now?: number;
}): string[] => {
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(options.runsDirectory, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === options.latestRunId) continue;
    const runDirectory = path.join(options.runsDirectory, entry.name);
    const record = readJson<RunRecordSummary>(path.join(runDirectory, "status.json"));
    if (!record?.status || !TERMINAL_STATUSES.has(record.status)) continue;
    let fallback = now;
    try { fallback = fs.statSync(runDirectory).mtimeMs; } catch {}
    if (now - recordAgeReference(record, fallback) < options.retentionMs) continue;
    fs.rmSync(runDirectory, { recursive: true, force: true });
    removed.push(runDirectory);
  }
  return removed;
};
