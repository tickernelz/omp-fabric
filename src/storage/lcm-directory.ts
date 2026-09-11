import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";
import { defaultLedgerPath, type ProjectIdentity } from "./lcm-identity.js";

const DIRECTORY_FILE = "projects.json";
const DIRECTORY_VERSION = 1;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface LcmDirectoryRecord {
  key: string;
  path: string;
  updatedAt: number;
}

interface LcmDirectoryFile {
  version: number;
  sweptAt: number;
  projects: LcmDirectoryRecord[];
}

export interface LcmSweepResult {
  removed: string[];
  bytes: number;
  skipped: boolean;
}

const empty = (): LcmDirectoryFile => ({ version: DIRECTORY_VERSION, sweptAt: 0, projects: [] });

const directoryFile = (rootDir: string): string => path.join(rootDir, DIRECTORY_FILE);

const read = (rootDir: string): LcmDirectoryFile => {
  try {
    const parsed = JSON.parse(fs.readFileSync(directoryFile(rootDir), "utf8")) as Partial<LcmDirectoryFile>;
    if (parsed.version !== DIRECTORY_VERSION || !Array.isArray(parsed.projects)) return empty();
    return {
      version: DIRECTORY_VERSION,
      sweptAt: typeof parsed.sweptAt === "number" ? parsed.sweptAt : 0,
      projects: parsed.projects.filter(
        (record): record is LcmDirectoryRecord =>
          typeof record?.key === "string" && typeof record.path === "string" && typeof record.updatedAt === "number",
      ),
    };
  } catch {
    return empty();
  }
};

/** Merges against the file on disk so a concurrent instance never loses its record. */
const write = (rootDir: string, file: LcmDirectoryFile, owned: readonly string[]): void => {
  try {
    fs.mkdirSync(rootDir, { recursive: true });
    const current = read(rootDir);
    const merged = new Map(current.projects.map((record) => [record.path, record] as const));
    for (const path of owned) merged.delete(path);
    for (const record of file.projects) merged.set(record.path, record);
    writeJsonAtomic(directoryFile(rootDir), {
      version: DIRECTORY_VERSION,
      sweptAt: Math.max(file.sweptAt, current.sweptAt),
      projects: [...merged.values()],
    });
  } catch {}
};

const ledgerFiles = (key: string, rootDir: string): string[] => {
  const base = defaultLedgerPath(rootDir, key);
  return [base, `${base}-wal`, `${base}-shm`];
};

/** Remembers the key a canonical path was first filed under, so history follows the path across inode changes. */
export const stableProjectKey = (rootDir: string, identity: ProjectIdentity, now = Date.now()): string => {
  const canonicalPath = identity.canonicalPath;
  if (!canonicalPath) return identity.key;
  const file = read(rootDir);
  const record = file.projects.find((candidate) => candidate.path === canonicalPath);
  const adopted = record && record.key !== identity.key && fs.existsSync(defaultLedgerPath(rootDir, record.key))
    ? record.key
    : identity.key;
  write(rootDir, { ...file, projects: [{ key: adopted, path: canonicalPath, updatedAt: now }] }, [canonicalPath]);
  return adopted;
};

/** Removes ledgers whose project directory is gone and that nothing wrote for the retention window. */
export const sweepLedgers = (
  rootDir: string,
  options: { keepKey: string; now?: number; retentionMs?: number; force?: boolean },
): LcmSweepResult => {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? RETENTION_MS;
  const file = read(rootDir);
  if (!options.force && now - file.sweptAt < SWEEP_INTERVAL_MS) return { removed: [], bytes: 0, skipped: true };
  const removed: string[] = [];
  let bytes = 0;
  const kept: LcmDirectoryRecord[] = [];
  for (const record of file.projects) {
    const ledger = defaultLedgerPath(rootDir, record.key);
    let stats: fs.Stats | undefined;
    try {
      stats = fs.statSync(ledger);
    } catch {
      continue;
    }
    const abandoned =
      record.key !== options.keepKey &&
      !fs.existsSync(record.path) &&
      now - Math.max(stats.mtimeMs, record.updatedAt) >= retentionMs;
    if (!abandoned) {
      kept.push(record);
      continue;
    }
    try {
      for (const target of ledgerFiles(record.key, rootDir)) fs.rmSync(target, { force: true });
    } catch {
      kept.push(record);
      continue;
    }
    bytes += stats.size;
    removed.push(record.path);
  }
  write(rootDir, { ...file, sweptAt: now, projects: kept }, file.projects.map((record) => record.path));
  return { removed, bytes, skipped: false };
};
