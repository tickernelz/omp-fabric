import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ProjectIdentityInput { recordedCwd?: string; liveCwd?: string }
export interface ProjectIdentity { version: 1; key: string; canonicalPath?: string; device?: number; inode?: number; aliases: string[] }
const LCM_LEDGER_WARNING_BYTES = 8 * 1024 ** 3;
const LCM_LEDGER_MAINTENANCE_BYTES = 10 * 1024 ** 3;
export interface LedgerOptions { dbPath?: string; rootDir?: string; project?: ProjectIdentityInput; now?: () => number; warningBytes?: number; maintenanceBytes?: number }
export type OperationalState = "healthy" | "warning" | "maintenance" | "degraded";
export interface CheckpointMetrics { mode: "passive" | "truncate"; busy: number; logPages: number; checkpointedPages: number; truncated: boolean }
export interface BackupManifest { format: "lcm-ledger-backup"; version: 1; source: string; destination: string; sourceSha256: string; backupSha256: string; sourceStateSha256: string; rowCounts: Record<string, number>; integrity: "ok" | string; createdAt: number }
export interface DeleteConfirmationToken { readonly projectKey: string; readonly value: string; readonly __brand: "DeleteConfirmationToken" }
export function createDeleteConfirmationToken(projectKey: string): DeleteConfirmationToken { return { projectKey, value: hash(`delete:${projectKey}`), __brand: "DeleteConfirmationToken" }; }
export interface SessionEntry { projectKey: string; sessionId: string; entryId: string; revision?: number; role: string; content: string; payloadJson: string; parentEntryId?: string | null; branch?: string | null; recordedCwd?: string; createdAt?: number }
export interface RawEntry extends SessionEntry { revision: number; contentHash: string; payloadHash: string; createdAt: number }

export function canonicalLcmPayload(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item !== null && typeof item === "object") return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(item);
  };
  return encode(normalized);
}
export function hashLcmPayload(value: unknown): string { return crypto.createHash("sha256").update(canonicalLcmPayload(value), "utf8").digest("hex"); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (project_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_aliases (alias TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key));
CREATE TABLE IF NOT EXISTS sessions (project_key TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, session_id));
CREATE TABLE IF NOT EXISTS raw_entries (project_key TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, payload_json TEXT NOT NULL, parent_entry_id TEXT, branch TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, session_id, entry_id, revision), UNIQUE(project_key, session_id, entry_id, content_hash));
CREATE TABLE IF NOT EXISTS summary_nodes (node_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS summary_edges (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY(parent_id, child_id));
CREATE TABLE IF NOT EXISTS frontiers (project_key TEXT NOT NULL, frontier_id TEXT NOT NULL, node_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, frontier_id, node_id));
CREATE TABLE IF NOT EXISTS maintenance_jobs (job_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance_usage (project_key TEXT NOT NULL, day TEXT NOT NULL, session_id TEXT NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost REAL NOT NULL, wall_ms INTEGER NOT NULL, PRIMARY KEY(project_key,day,session_id));
CREATE INDEX IF NOT EXISTS raw_entries_lookup ON raw_entries(project_key, session_id, entry_id, revision);
`;

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const fileHash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const snapshotHash = (db: DatabaseSync): string => {
  const digest = crypto.createHash("sha256");
  for (const [table, order] of [["schema_metadata", "key"], ["projects", "project_key"], ["project_aliases", "alias"], ["sessions", "project_key,session_id"], ["raw_entries", "project_key,session_id,entry_id,revision"], ["summary_nodes", "node_id"], ["summary_edges", "parent_id,child_id"], ["frontiers", "project_key,frontier_id,node_id"], ["maintenance_jobs", "job_id"], ["maintenance_usage", "project_key,day,session_id"]] as const) {
    digest.update(`${table}\0`);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()) digest.update(`${JSON.stringify(row)}\0`);
  }
  return digest.digest("hex");
};
const normalize = (p: string) => path.normalize(path.resolve(p));
const statIdentity = (p: string) => { try { const s = fs.statSync(p); return { device: Number(s.dev), inode: Number(s.ino) }; } catch { return {}; } };

export function canonicalProjectIdentity(input: ProjectIdentityInput): ProjectIdentity {
  const source = input.recordedCwd?.trim() || input.liveCwd?.trim();
  if (!source) throw new Error("project cwd is required");
  const normalized = normalize(source);
  let canonicalPath = normalized;
  try { canonicalPath = fs.realpathSync.native(normalized); } catch {}
  const ids = statIdentity(canonicalPath);
  const key = ids.device !== undefined && ids.inode !== undefined ? `v1:devino:${ids.device}:${ids.inode}` : `v1:path:${canonicalPath}`;
  return { version: 1, key, canonicalPath, ...ids, aliases: [normalized, canonicalPath] };
}

export function defaultLedgerPath(rootDir = path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || ".", ".local", "state"), "omp-fabric", "lcm"), projectKey = "default"): string {
  return path.join(rootDir, `${hash(projectKey).slice(0, 24)}.sqlite`);
}

class LedgerDegradedError extends Error { constructor(message: string, public readonly cause?: unknown) { super(message); this.name = "LedgerDegradedError"; } }

export class LcmLedger {
  readonly db: DatabaseSync;
  readonly project: ProjectIdentity;
  private degraded = false;
  private readonly dbPath: string;
  private readonly now: () => number;
  private readonly warningBytes: number;
  private readonly maintenanceBytes: number;
  private writeChain: Promise<void> = Promise.resolve();
  private transactionDepth = 0;
  private closed = false;
  constructor(options: LedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.warningBytes = options.warningBytes ?? LCM_LEDGER_WARNING_BYTES;
    this.maintenanceBytes = options.maintenanceBytes ?? LCM_LEDGER_MAINTENANCE_BYTES;
    if (!Number.isSafeInteger(this.warningBytes) || !Number.isSafeInteger(this.maintenanceBytes) || this.warningBytes < 0 || this.maintenanceBytes < this.warningBytes) {
      throw new Error("invalid ledger size thresholds");
    }
    this.project = canonicalProjectIdentity(options.project ?? { liveCwd: process.cwd() });
    const dbPath = options.dbPath ?? defaultLedgerPath(options.rootDir, this.project.key);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000;");
      this.db.exec("BEGIN IMMEDIATE;" + SCHEMA + "INSERT INTO schema_metadata(key,value) VALUES ('version','1') ON CONFLICT(key) DO UPDATE SET value='1'; COMMIT;");
      const columns = this.db.prepare("PRAGMA table_info(raw_entries)").all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === "payload_json")) {
        if (Number((this.db.prepare("SELECT count(*) n FROM raw_entries").get() as { n: number }).n)) throw new Error("raw payloads missing; reimport authoritative session entries");
        this.db.exec("ALTER TABLE raw_entries ADD COLUMN payload_json TEXT NOT NULL DEFAULT ''");
      }
      const result = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (result.integrity_check !== "ok") throw new Error(String(result.integrity_check));
      this.registerProject(this.project);
    } catch (error) { this.degraded = true; throw new LedgerDegradedError("ledger startup failed", error); }
  }
  get isDegraded() { return this.degraded; }
  get operationalState(): OperationalState {
    if (this.degraded) return "degraded";
    try { const size = fs.statSync(this.dbPath).size; if (size >= this.maintenanceBytes) return "maintenance"; if (size >= this.warningBytes) return "warning"; } catch {}
    return "healthy";
  }
  markDegraded(error?: unknown) { this.degraded = true; return new LedgerDegradedError("ledger is degraded", error); }
  private registerProject(identity: ProjectIdentity) {
    const now = this.now();
    this.db.prepare("INSERT INTO projects(project_key,identity_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_key) DO UPDATE SET identity_json=excluded.identity_json,updated_at=excluded.updated_at").run(identity.key, JSON.stringify(identity), now, now);
    for (const alias of identity.aliases) {
      const existing = this.db.prepare("SELECT project_key FROM project_aliases WHERE alias=?").get(alias) as { project_key?: string } | undefined;
      if (existing && existing.project_key !== identity.key) throw new LedgerDegradedError(`ambiguous project alias: ${alias}`);
      this.db.prepare("INSERT OR IGNORE INTO project_aliases(alias,project_key) VALUES(?,?)").run(alias, identity.key);
    }
  }
  private guard() { if (this.degraded) throw new LedgerDegradedError("ledger is degraded"); }
  private assertProjectKey(projectKey: string) { if (projectKey !== this.project.key) throw new Error("project key does not match ledger project"); }
  async serialize<T>(operation: () => T): Promise<T> { const previous = this.writeChain; let release!: () => void; this.writeChain = new Promise<void>(resolve => { release = resolve }); await previous; try { this.guard(); return operation(); } finally { release(); } }
  appendRaw(entry: SessionEntry): RawEntry {
    this.guard();
    if (entry.projectKey !== this.project.key) throw new Error("entry project does not match ledger project");
    if (entry.entryId.trim().length === 0) throw new Error("entry ID is required");
    if (typeof entry.payloadJson !== "string" || !entry.payloadJson.trim()) throw new Error("full payload JSON is required");
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(entry.payloadJson) as Record<string, unknown>; } catch { throw new Error("invalid payload JSON"); }
    if (!payload || typeof payload !== "object" || typeof payload.type !== "string" || typeof payload.id !== "string" || payload.id !== entry.entryId) throw new Error("payload must be a full SessionEntry");
    const payloadJson = canonicalLcmPayload(payload);
    const contentHash = hashLcmPayload(payload);
    const ownsTransaction = this.transactionDepth === 0;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT revision,created_at FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND content_hash=?").get(entry.projectKey, entry.sessionId, entry.entryId, contentHash) as { revision: number; created_at: number } | undefined;
      if (existing) { if (ownsTransaction) this.db.exec("COMMIT"); return { ...entry, payloadJson, payloadHash: contentHash, revision: existing.revision, contentHash, createdAt: existing.created_at }; }
      const latest = this.db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=?").get(entry.projectKey, entry.sessionId, entry.entryId) as { revision: number };
      const revision = latest.revision + 1; const createdAt = entry.createdAt ?? this.now();
      this.db.prepare("INSERT OR IGNORE INTO sessions(project_key,session_id,created_at) VALUES(?,?,?)").run(entry.projectKey, entry.sessionId, createdAt);
      this.db.prepare("INSERT INTO raw_entries(project_key,session_id,entry_id,revision,role,content,content_hash,payload_json,parent_entry_id,branch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(entry.projectKey,entry.sessionId,entry.entryId,revision,entry.role,entry.content,contentHash,payloadJson,entry.parentEntryId ?? null,entry.branch ?? null,createdAt);
      if (ownsTransaction) this.db.exec("COMMIT");
      return { ...entry, payloadJson, payloadHash: contentHash, revision, contentHash, createdAt };
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      const code = (error as NodeJS.ErrnoException).code; if (code === "ENOSPC" || code === "SQLITE_FULL" || String(error).includes("database or disk is full")) this.degraded = true; throw new LedgerDegradedError("ledger write failed", error);
    }
  }
  readRaw(projectKey = this.project.key, sessionId?: string): RawEntry[] { this.guard(); this.assertProjectKey(projectKey); const rows = sessionId ? this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at,revision").all(projectKey,sessionId) : this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? ORDER BY created_at,session_id,entry_id,revision").all(projectKey); return (rows as Array<Record<string, unknown>>).map(row => ({ projectKey: row.project_key as string, sessionId: row.session_id as string, entryId: row.entry_id as string, revision: row.revision as number, role: row.role as string, content: row.content as string, contentHash: row.content_hash as string, payloadHash: row.content_hash as string, payloadJson: row.payload_json as string, parentEntryId: row.parent_entry_id as string | null, branch: row.branch as string | null, createdAt: row.created_at as number })); }
  readRawPage(projectKey = this.project.key, sessionId?: string, offset = 0, limit = 100): RawEntry[] { if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid raw page"); this.guard(); this.assertProjectKey(projectKey); const rows = sessionId ? this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at,revision LIMIT ? OFFSET ?").all(projectKey,sessionId,limit,offset) : this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? ORDER BY created_at,session_id,entry_id,revision LIMIT ? OFFSET ?").all(projectKey,limit,offset); return (rows as Array<Record<string, unknown>>).map(row => ({ projectKey: row.project_key as string, sessionId: row.session_id as string, entryId: row.entry_id as string, revision: row.revision as number, role: row.role as string, content: row.content as string, contentHash: row.content_hash as string, payloadHash: row.content_hash as string, payloadJson: row.payload_json as string, parentEntryId: row.parent_entry_id as string | null, branch: row.branch as string | null, createdAt: row.created_at as number })); }
  readRawEntry(projectKey: string, sessionId: string, entryId: string, revision: number): RawEntry | undefined { this.guard(); this.assertProjectKey(projectKey); const row = this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND revision=?").get(projectKey,sessionId,entryId,revision) as Record<string, unknown> | undefined; return row ? { projectKey: row.project_key as string, sessionId: row.session_id as string, entryId: row.entry_id as string, revision: row.revision as number, role: row.role as string, content: row.content as string, contentHash: row.content_hash as string, payloadHash: row.content_hash as string, payloadJson: row.payload_json as string, parentEntryId: row.parent_entry_id as string | null, branch: row.branch as string | null, createdAt: row.created_at as number } : undefined; }
  readOnly<T>(fn: (db: DatabaseSync) => T): T { this.guard(); return fn(this.db); }
  transaction<T>(fn: (db: DatabaseSync) => T): T { this.guard(); if (this.transactionDepth > 0) return fn(this.db); this.db.exec("BEGIN IMMEDIATE"); this.transactionDepth = 1; try { const result = fn(this.db); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } finally { this.transactionDepth = 0; } }
  checkpoint(mode: "passive" | "truncate" = "passive"): CheckpointMetrics {
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode.toUpperCase()})`).get() as { busy?: number; log?: number; checkpointed?: number };
    const busy = row.busy ?? 0;
    const logPages = row.log ?? 0;
    return { mode, busy, logPages, checkpointedPages: row.checkpointed ?? 0, truncated: mode === "truncate" && busy === 0 && logPages === 0 };
  }
  backup(destination: string): BackupManifest {
    this.guard();
    return this.serializeSync(() => {
      const target = path.resolve(destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) throw new Error("backup destination exists");
      this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      fs.chmodSync(target, 0o600);
      const copy = new DatabaseSync(target);
      let integrity = "unknown";
      let backupStateSha256 = "";
      const rowCounts: Record<string, number> = {};
      try {
        integrity = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check ?? "unknown";
        for (const table of ["projects", "sessions", "raw_entries", "summary_nodes", "summary_edges", "frontiers", "maintenance_jobs", "maintenance_usage"]) {
          rowCounts[table] = Number((copy.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
        }
        backupStateSha256 = snapshotHash(copy);
      } finally {
        copy.close();
      }
      const manifest: BackupManifest = { format: "lcm-ledger-backup", version: 1, source: this.dbPath, destination: target, sourceSha256: fileHash(this.dbPath), backupSha256: fileHash(target), sourceStateSha256: backupStateSha256, rowCounts, integrity, createdAt: this.now() };
      fs.writeFileSync(`${target}.manifest.json`, JSON.stringify(manifest), { mode: 0o600 });
      fs.chmodSync(`${target}.manifest.json`, 0o600);
      return manifest;
    });
  }
  exportBackup(destination: string): BackupManifest { return this.backup(destination); }
  deleteProject(token: DeleteConfirmationToken, backupManifest: BackupManifest): void {
    this.guard();
    if (token.__brand !== "DeleteConfirmationToken" || token.projectKey !== this.project.key || token.value !== hash(`delete:${this.project.key}`)) throw new Error("invalid delete confirmation token");
    const backupDb = fs.existsSync(backupManifest.destination) ? new DatabaseSync(backupManifest.destination) : undefined;
    let backupStateSha256: string | undefined;
    try {
      if (backupDb) backupStateSha256 = snapshotHash(backupDb);
    } finally {
      backupDb?.close();
    }
    if (backupManifest.integrity !== "ok" || backupManifest.source !== this.dbPath || !backupManifest.backupSha256 || backupManifest.backupSha256 !== fileHash(backupManifest.destination) || !backupManifest.sourceStateSha256 || backupManifest.sourceStateSha256 !== backupStateSha256 || backupManifest.sourceSha256 !== fileHash(this.dbPath) || backupManifest.sourceStateSha256 !== snapshotHash(this.db)) throw new Error("backup verification failed");
    this.transaction(db => {
      db.prepare("DELETE FROM summary_edges WHERE parent_id IN (SELECT node_id FROM summary_nodes WHERE project_key=?) OR child_id IN (SELECT node_id FROM summary_nodes WHERE project_key=?)").run(this.project.key, this.project.key);
      for (const table of ["raw_entries", "sessions", "frontiers", "summary_nodes", "maintenance_jobs", "maintenance_usage"]) db.prepare(`DELETE FROM ${table} WHERE project_key=?`).run(this.project.key);
      db.prepare("DELETE FROM project_aliases WHERE project_key=?").run(this.project.key);
      db.prepare("DELETE FROM projects WHERE project_key=?").run(this.project.key);
    });
    const integrity = (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check;
    if (integrity !== "ok") throw new Error(`post-delete integrity failed: ${integrity}`);
    const audit = { format: "lcm-ledger-delete", version: 1, projectKey: this.project.key, deletedAt: this.now(), integrity, remaining: Number((this.db.prepare("SELECT count(*) n FROM projects WHERE project_key=?").get(this.project.key) as { n: number }).n) };
    fs.writeFileSync(`${backupManifest.destination}.delete-manifest.json`, JSON.stringify(audit), { mode: 0o600 });
  }
  private serializeSync<T>(operation: () => T): T { this.guard(); return operation(); }
  close() { if (this.closed) return; this.db.close(); this.closed = true; }
}
