import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sqliteDriver, type SqliteDatabase } from "./sqlite.js";
import { sessionsDirRoot, sessionDirNamesForCwd } from "../memory/discovery.js";
import { canonicalLcmPayload, canonicalProjectIdentity, defaultLedgerPath, hashLcmPayload, LcmLedger } from "./lcm-ledger.js";

export interface MigrationOptions {
  agentDir: string;
  ledgerRoot?: string;
  ledger?: LcmLedger;
  files?: string[];
  candidateDirs?: string[];
  projectCwd?: string;
  liveCwd?: string;
  since?: string;
  until?: string;
  onDemand?: boolean;
  now?: number;
  apply?: boolean;
  allowIncompleteDiscovery?: boolean;
  maxFiles?: number;
  maxDiscoveryEntries?: number;
  maxFileBytes?: number;
  maxLineBytes?: number;
  maxTotalBytes?: number;
  onProgress?: (progress: MigrationProgress) => void;
}
interface MigrationProgress {
  projectKey: string;
  sessionPath: string;
  sourceHash: string;
  lineOrdinal: number;
  entryId: string;
  contentHash: string;
}
interface MigrationCounts {
  eligible: number;
  imported: number;
  skippedDuplicate: number;
  skippedOutOfWindow: number;
  malformed: number;
  oversized: number;
  incompleteDiscovery: number;
  raced: number;
  errors: number;
}
export interface MigrationDrops {
  oversizedFiles: number;
  oversizedFileBytes: number;
  oversizedLines: number;
  oversizedLineBytes: number;
  skippedFiles: number;
  entries: number;
}
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const megabytes = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
/** One sentence per non-empty drop category; empty when nothing was dropped. */
export const migrationDropReasons = (drops: MigrationDrops): string[] => {
  const reasons: string[] = [];
  if (drops.oversizedFiles > 0) reasons.push(`${plural(drops.oversizedFiles, "session file")} skipped as oversized (${megabytes(drops.oversizedFileBytes)})`);
  if (drops.oversizedLines > 0) reasons.push(`${plural(drops.oversizedLines, "line")} skipped as oversized (${megabytes(drops.oversizedLineBytes)})`);
  if (drops.skippedFiles > 0) reasons.push(`${plural(drops.skippedFiles, "session file")} skipped after the total scan budget`);
  return reasons;
};
export interface MigrationResult {
  mode: "apply" | "dry-run";
  since: string;
  until: string;
  counts: MigrationCounts;
  drops: MigrationDrops;
  degraded: boolean;
  filesScanned: number;
  bytesScanned: number;
  generations: Array<{ sessionPath: string; sourceHash: string }>;
  exitCode: number;
}
const hash = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
/** Session JSONL is append-only, so a longer file is the live session growing. */
export const sourceStillValid = (before: number, after: number): boolean => after >= before;
const SOURCE_READ_ATTEMPTS = 3;
class SourceChangedError extends Error {}
type SourceRead =
  | { kind: "data"; raced: number; data: Buffer }
  | { kind: "not-file"; raced: number }
  | { kind: "oversized"; raced: number; size: number }
  | { kind: "over-budget"; raced: number }
  | { kind: "raced"; raced: number }
  | { kind: "error"; raced: number };
const readSource = (file: string, maxFileBytes: number, remainingBytes: number): SourceRead => {
  let raced = 0;
  for (let attempt = 0; attempt < SOURCE_READ_ATTEMPTS; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const before = fs.fstatSync(fd);
      if (!before.isFile()) return { kind: "not-file", raced };
      if (before.size > maxFileBytes) return { kind: "oversized", raced, size: before.size };
      if (before.size > remainingBytes) return { kind: "over-budget", raced };
      const data = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < data.length) {
        const size = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (size === 0) throw new SourceChangedError("source shortened during read");
        offset += size;
      }
      if (!sourceStillValid(before.size, fs.fstatSync(fd).size)) throw new SourceChangedError("source shrank during read");
      return { kind: "data", raced, data };
    } catch (error) {
      if (!(error instanceof SourceChangedError)) return { kind: "error", raced };
      raced += 1;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return { kind: "raced", raced };
};
const utc = (value: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00)$/.test(value)) throw new Error("timestamps must be explicit UTC ISO-8601 values");
  const at = Date.parse(value);
  const normalized = value.replace("+00:00", "Z").replace(/Z$/, "");
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== normalized.slice(0, 19)) throw new Error("invalid UTC timestamp");
  return at;
};
export function migrationWindow(options: Pick<MigrationOptions, "since" | "until" | "now">): { since: number; until: number } {
  const now = options.now ?? Date.now();
  const since = options.since === undefined ? now - 72 * 60 * 60 * 1000 : utc(options.since);
  const until = options.until === undefined ? now : utc(options.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("invalid migration window");
  return { since, until };
}
const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("scan limits must be positive safe integers");
  return result;
};
export function discoverMigrationSessions(options: MigrationOptions): { files: string[]; incomplete: number } {
  const maxFiles = positive(options.maxFiles, 10_000);
  const maxEntries = positive(options.maxDiscoveryEntries, 100_000);
  const files = new Set<string>();
  let incomplete = 0;
  let entries = 0;
  const add = (file: string): void => {
    if (files.size >= maxFiles && !files.has(path.resolve(file))) { incomplete++; return; }
    files.add(path.resolve(file));
  };
  if (options.files) {
    for (const file of options.files.slice(0, maxFiles)) add(file);
    if (options.files.length > maxFiles) incomplete++;
    return { files: [...files].sort(), incomplete };
  }
  const list = (dir: string, visit: (entry: fs.Dirent) => void): void => {
    let handle: fs.Dir | undefined;
    try {
      handle = fs.opendirSync(dir);
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        if (++entries > maxEntries) { incomplete++; break; }
        visit(entry);
      }
    } catch { incomplete++; } finally { handle?.closeSync(); }
  };
  const scan = (dir: string): void => list(dir, entry => {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) add(path.join(dir, entry.name));
    else if (entry.isSymbolicLink() && entry.name.endsWith(".jsonl")) incomplete++;
  });
  if (options.candidateDirs) {
    for (const dir of options.candidateDirs) { if (entries >= maxEntries) { incomplete++; break; } scan(dir); }
  } else if (options.projectCwd) {
    const names = sessionDirNamesForCwd(options.projectCwd);
    let found = false;
    for (const name of [names.canonical, ...names.legacy]) {
      const dir = path.join(sessionsDirRoot(options.agentDir), name);
      try { if (fs.statSync(dir).isDirectory()) { found = true; scan(dir); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete++; }
    }
    if (!found) incomplete++;
  } else {
    const root = sessionsDirRoot(options.agentDir);
    list(root, entry => {
      if (entry.isDirectory()) scan(path.join(root, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) add(path.join(root, entry.name));
      else if (entry.isSymbolicLink()) incomplete++;
    });
  }
  return { files: [...files].sort(), incomplete };
}
const CHECKPOINT_SCHEMA =   "CREATE TABLE IF NOT EXISTS migration_checkpoints (project_key TEXT NOT NULL, session_path TEXT NOT NULL, source_hash TEXT NOT NULL, line_ordinal INTEGER NOT NULL, entry_id TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(project_key,session_path,source_hash,line_ordinal,entry_id,content_hash))";
export function reconcileSession(options: Omit<MigrationOptions, "files"> & { files: [string] }): MigrationResult {
  return migrateSessions({ ...options, onDemand: true });
}

export function migrateSessions(options: MigrationOptions): MigrationResult {
  const window = migrationWindow(options);
  const maxFileBytes = positive(options.maxFileBytes, 64 * 1024 ** 2);
  const maxLineBytes = positive(options.maxLineBytes, 8 * 1024 ** 2);
  const maxTotalBytes = positive(options.maxTotalBytes, 1024 ** 3);
  const discovery = discoverMigrationSessions(options);
  const result: MigrationResult = {
    mode: options.apply ? "apply" : "dry-run", since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString(),
    counts: { eligible: 0, imported: 0, skippedDuplicate: 0, skippedOutOfWindow: 0, malformed: 0, oversized: 0, incompleteDiscovery: discovery.incomplete, raced: 0, errors: 0 },
    drops: { oversizedFiles: 0, oversizedFileBytes: 0, oversizedLines: 0, oversizedLineBytes: 0, skippedFiles: 0, entries: 0 },
    degraded: false,
    filesScanned: 0, bytesScanned: 0, generations: [], exitCode: 0,
  };
  const counts = result.counts;
  const drops = result.drops;
  const drySeen = new Set<string>();
  files: for (const [position, file] of discovery.files.entries()) {
    const read = readSource(file, maxFileBytes, maxTotalBytes - result.bytesScanned);
    counts.raced += read.raced;
    if (read.kind !== "data") {
      switch (read.kind) {
        case "not-file": counts.incompleteDiscovery++; break;
        case "oversized": counts.oversized++; drops.oversizedFiles++; drops.oversizedFileBytes += read.size; break;
        case "over-budget": counts.incompleteDiscovery++; drops.skippedFiles += discovery.files.length - position; break files;
        case "raced": counts.incompleteDiscovery++; break;
        default: counts.errors++; counts.incompleteDiscovery++;
      }
      continue;
    }
    const data = read.data;
    result.filesScanned++;
    result.bytesScanned += data.length;
    const sourceHash = hash(data);
    result.generations.push({ sessionPath: file, sourceHash });
    let header: Record<string, unknown> | undefined;
    let ledger: LcmLedger | undefined;
    let database: SqliteDatabase | undefined;
    let sessionId = "";
    let projectKey = "";
    let cwd: string | undefined;
    let ordinal = 0;
    try {
      for (let start = 0; start < data.length;) {
        ordinal++;
        const newline = data.indexOf(10, start);
        const end = newline < 0 ? data.length : newline;
        const bytes = data.subarray(start, end);
        start = newline < 0 ? data.length : end + 1;
        if (bytes.length > maxLineBytes) { counts.oversized++; drops.oversizedLines++; drops.oversizedLineBytes += bytes.length; drops.entries++; continue; }
        const content = bytes.toString("utf8").replace(/\r$/, "");
        if (!content.trim()) continue;
        let row: Record<string, unknown> | undefined;
        try { row = record(JSON.parse(content)); } catch { counts.malformed++; continue; }
        if (!row) { counts.malformed++; continue; }
        if (row.type === "message_end") continue;
        if (!header) {
          if (row.type !== "session") { if (record(row.message)) counts.malformed++; continue; }
          if (!nonblank(row.id)) { counts.malformed++; break; }
          header = row;
          sessionId = row.id;
          cwd = nonblank(row.cwd) ? row.cwd : options.liveCwd;
          if (!cwd) { counts.malformed++; break; }
          const projectInput = options.liveCwd ? { recordedCwd: cwd, liveCwd: options.liveCwd } : { recordedCwd: cwd };
          projectKey = canonicalProjectIdentity(projectInput).key;
          if (options.ledger && options.ledger.project.key !== projectKey) { counts.errors++; break; }
          if (options.apply) {
            if (options.ledger) ledger = options.ledger;
            else if (options.ledgerRoot) ledger = new LcmLedger({ rootDir: options.ledgerRoot, project: { recordedCwd: cwd } });
            else ledger = new LcmLedger({ project: { recordedCwd: cwd } });
            database = ledger.db;
            database.exec(CHECKPOINT_SCHEMA);
          } else if (options.ledger) database = options.ledger.db;
          else {
            const dbPath = defaultLedgerPath(options.ledgerRoot, projectKey);
            if (fs.existsSync(dbPath)) database = new (sqliteDriver())(dbPath, { readOnly: true });
          }
          continue;
        }
        if (row.type === "session" || !nonblank(row.type) || !nonblank(row.id) || (row.parentId !== null && row.parentId !== undefined && typeof row.parentId !== "string")) { counts.malformed++; continue; }
        const message = record(row.message);
        if (row.type === "message" && (!message || !nonblank(message.role))) { counts.malformed++; continue; }
        let at: number;
        try { at = typeof row.timestamp === "string" ? utc(row.timestamp) : NaN; } catch { at = NaN; }
        if (!Number.isFinite(at)) { counts.malformed++; continue; }
        if (!options.onDemand && (at < window.since || at > window.until)) { counts.skippedOutOfWindow++; continue; }
        counts.eligible++;
        const payloadJson = canonicalLcmPayload(row);
        const contentHash = hashLcmPayload(row);
        const identity = JSON.stringify([projectKey, sessionId, row.id, contentHash]);
        const progress: MigrationProgress = { projectKey, sessionPath: file, sourceHash, lineOrdinal: ordinal, entryId: row.id, contentHash };
        const duplicate = drySeen.has(identity) || database?.prepare("SELECT 1 FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND content_hash=?").get(projectKey, sessionId, row.id, contentHash) !== undefined;
        if (duplicate) counts.skippedDuplicate++;
        else if (ledger) {
          ledger.appendRaw({
            projectKey, sessionId, entryId: row.id, role: message && typeof message.role === "string" ? message.role : row.type,
            content, payloadJson, parentEntryId: typeof row.parentId === "string" ? row.parentId : null,
            branch: typeof row.branch === "string" ? row.branch : typeof row.branchId === "string" ? row.branchId : null,
            ...(cwd ? { recordedCwd: cwd } : {}), createdAt: at
          });
          counts.imported++;
        }
        else if (!duplicate) counts.imported++;
        drySeen.add(identity);
        if (ledger) database!.prepare("INSERT OR IGNORE INTO migration_checkpoints(project_key,session_path,source_hash,line_ordinal,entry_id,content_hash) VALUES(?,?,?,?,?,?)")
          .run(projectKey, file, sourceHash, ordinal, row.id, contentHash);
        options.onProgress?.(progress);
      }
      if (!header) counts.malformed++;
    } catch (error) {
      counts.errors++;
      if (options.onProgress) throw error;
    } finally {
      if (ledger && ledger !== options.ledger) ledger.close();
      else if (!ledger && database && database !== options.ledger?.db) database.close();
    }
  }
  result.degraded = drops.entries > 0 || drops.oversizedFiles > 0 || drops.skippedFiles > 0;
  result.exitCode = counts.errors || counts.malformed || counts.oversized || (counts.incompleteDiscovery && !options.allowIncompleteDiscovery) ? 1 : 0;
  return result;
}
