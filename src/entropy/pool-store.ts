// Persistence for the machine-wide observation pool: <agent
// dir>/fabric/entropy/observation-pool.json, locked across OMP processes
// sharing the agent directory. A damaged pool surfaces as an error and
// blocks merges from overwriting it, the same discipline as the compiled
// surface. The pool is pure derived evidence (session audits are the
// source of truth), so it never gates enforcement, only thresholds.

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, writeJsonAtomicAsync } from "../core/atomic-write.js";
import { withExclusiveFileLock, withExclusiveFileLockAsync } from "../core/file-lock.js";
import {
  OBSERVATION_POOL_VERSION,
  type EntropyObservationPoolEntry,
  type EntropyObservationPoolFile,
  type EntropyPoolTrackedSession,
  type EntropyPoolValueCount,
} from "./pool.js";

const POOL_LOCK_ATTEMPTS = 50;
const POOL_LOCK_DELAY_MS = 5;
const POOL_STALE_LOCK_MS = 30_000;

// Parse bounds: generous over the merge's own caps so a future cap change
// never bricks an existing pool, tight enough that a damaged file cannot
// claim unbounded memory.
const POOL_MAX_ENTRIES = 8_192;
const POOL_MAX_VALUES_PER_ENTRY = 64;
const POOL_MAX_TRACKED = 64;
const POOL_MAX_BAKED = 2_048;

export const observationPoolDirectory = (agentDir: string): string =>
  path.join(agentDir, "fabric", "entropy");

const poolPath = (directory: string): string => path.join(directory, "observation-pool.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const parseValueCount = (value: unknown): EntropyPoolValueCount | undefined => {
  if (!isRecord(value) || !isPrimitive(value.value)) return undefined;
  if (!Number.isSafeInteger(value.count) || (value.count as number) < 1) return undefined;
  return { value: value.value, count: value.count as number };
};

const parseEntry = (value: unknown): EntropyObservationPoolEntry | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string" || !value.ref.trim()) return undefined;
  if (typeof value.key !== "string" || !value.key.trim()) return undefined;
  if (!Number.isSafeInteger(value.total) || (value.total as number) < 0) return undefined;
  if (!Array.isArray(value.values) || value.values.length > POOL_MAX_VALUES_PER_ENTRY) {
    return undefined;
  }
  const values: EntropyPoolValueCount[] = [];
  for (const item of value.values) {
    const parsed = parseValueCount(item);
    if (!parsed) return undefined;
    values.push(parsed);
  }
  const seen = new Set<string>();
  for (const item of values) {
    const key = `${typeof item.value}:${String(item.value)}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
  }
  return { ref: value.ref.trim(), key: value.key.trim(), total: value.total as number, values };
};

const parseTrackedSession = (value: unknown): EntropyPoolTrackedSession | undefined => {
  if (!isRecord(value) || typeof value.file !== "string" || !value.file.trim()) return undefined;
  if (typeof value.digest !== "string" || !value.digest.trim()) return undefined;
  if (!isRecord(value.counts)) return undefined;
  const counts: Record<string, number> = {};
  for (const [identity, count] of Object.entries(value.counts)) {
    if (!Number.isSafeInteger(count) || (count as number) < 1) return undefined;
    counts[identity] = count as number;
  }
  return { file: value.file.trim(), digest: value.digest.trim(), counts };
};

const parsePoolFile = (value: unknown): EntropyObservationPoolFile | undefined => {
  if (!isRecord(value) || value.version !== OBSERVATION_POOL_VERSION) return undefined;
  if (!Array.isArray(value.entries) || value.entries.length > POOL_MAX_ENTRIES) return undefined;
  if (!Array.isArray(value.tracked) || value.tracked.length > POOL_MAX_TRACKED) return undefined;
  if (!Array.isArray(value.baked) || value.baked.length > POOL_MAX_BAKED) return undefined;
  if (!value.baked.every((digest) => typeof digest === "string" && digest.trim())) {
    return undefined;
  }
  const entries: EntropyObservationPoolEntry[] = []
  for (const entry of value.entries) {
    const parsed = parseEntry(entry);
    if (!parsed) return undefined;
    entries.push(parsed);
  }
  const tracked: EntropyPoolTrackedSession[] = [];
  const trackedFiles = new Set<string>();
  for (const session of value.tracked) {
    const parsed = parseTrackedSession(session);
    if (!parsed) return undefined;
    if (trackedFiles.has(parsed.file)) return undefined;
    trackedFiles.add(parsed.file);
    tracked.push(parsed);
  }
  const entrySeen = new Set<string>();
  for (const entry of entries) {
    const id = `${entry.ref}\u0000${entry.key}`;
    if (entrySeen.has(id)) return undefined;
    entrySeen.add(id);
  }
  return {
    version: OBSERVATION_POOL_VERSION,
    entries,
    tracked,
    baked: value.baked.map((digest) => (digest as string).trim()),
  };
};

export interface LoadedObservationPool {
  file?: EntropyObservationPoolFile;
  error?: string;
}

export const loadObservationPool = (agentDir: string): LoadedObservationPool => {
  const file = poolPath(observationPoolDirectory(agentDir));
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // A missing pool means evidence simply starts accumulating now.
    if (errorCode(error) === "ENOENT") return {};
    return { error: `observation pool is unreadable: ${errorText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "observation pool is malformed JSON" };
  }
  const parsedFile = parsePoolFile(parsed);
  if (!parsedFile) return { error: "observation pool is invalid" };
  return { file: parsedFile };
};

export const loadObservationPoolAsync = async (
  agentDir: string,
): Promise<LoadedObservationPool> => {
  const file = poolPath(observationPoolDirectory(agentDir));
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    return { error: `observation pool is unreadable: ${errorText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "observation pool is malformed JSON" };
  }
  const parsedFile = parsePoolFile(parsed);
  return parsedFile ? { file: parsedFile } : { error: "observation pool is invalid" };
};

export interface SavedObservationPool {
  file: EntropyObservationPoolFile;
  written: boolean;
}

export const saveObservationPool = (
  agentDir: string,
  file: EntropyObservationPoolFile,
): SavedObservationPool =>
  withExclusiveFileLock(
    {
      directory: observationPoolDirectory(agentDir),
      lockName: "observation-pool.lock",
      timeoutMessage: "Timed out waiting for the observation pool lock",
      attempts: POOL_LOCK_ATTEMPTS,
      delayMs: POOL_LOCK_DELAY_MS,
      staleMs: POOL_STALE_LOCK_MS,
    },
    () => {
      // A damaged pool must never be silently rebuilt; fail so the tick
      // records the skip and leaves the file for recovery.
      const loaded = loadObservationPool(agentDir);
      if (loaded.error) throw new Error(loaded.error);
      const target = poolPath(observationPoolDirectory(agentDir));
      const serialized = `${JSON.stringify(file, null, 2)}\n`;
      try {
        if (fs.readFileSync(target, "utf8") === serialized) return { file, written: false };
      } catch {
        // Missing file: proceed to write.
      }
      writeJsonAtomic(target, file, { space: 2, newline: true, mode: 0o600, dirMode: 0o700 });
      return { file, written: true };
    },
  );

export const saveObservationPoolAsync = async (
  agentDir: string,
  file: EntropyObservationPoolFile,
): Promise<SavedObservationPool> =>
  withExclusiveFileLockAsync(
    {
      directory: observationPoolDirectory(agentDir),
      lockName: "observation-pool.lock",
      timeoutMessage: "Timed out waiting for the observation pool lock",
      attempts: POOL_LOCK_ATTEMPTS,
      delayMs: POOL_LOCK_DELAY_MS,
      staleMs: POOL_STALE_LOCK_MS,
    },
    async () => {
      const loaded = await loadObservationPoolAsync(agentDir);
      if (loaded.error) throw new Error(loaded.error);
      const target = poolPath(observationPoolDirectory(agentDir));
      const serialized = `${JSON.stringify(file, null, 2)}\n`;
      try {
        if (await fs.promises.readFile(target, "utf8") === serialized) {
          return { file, written: false };
        }
      } catch {
        // Missing file: proceed to write.
      }
      await writeJsonAtomicAsync(target, file, {
        space: 2,
        newline: true,
        mode: 0o600,
        dirMode: 0o700,
      });
      return { file, written: true };
    },
  );
