import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sqliteDriver, type SqliteDatabase } from "./sqlite.js";
import { stableProjectKey } from "./lcm-directory.js";
import { canonicalLcmPayload, canonicalProjectIdentity, createDeleteConfirmationToken, defaultLedgerPath, defaultLedgerRoot, hash, hashLcmPayload, type DeleteConfirmationToken, type ProjectIdentity, type ProjectIdentityInput, type RawEntry, type SessionEntry } from "./lcm-identity.js";

export { canonicalLcmPayload, canonicalProjectIdentity, createDeleteConfirmationToken, defaultLedgerPath, hashLcmPayload };
export type { DeleteConfirmationToken, ProjectIdentity, RawEntry, SessionEntry };
const LCM_LEDGER_WARNING_BYTES = 8 * 1024 ** 3;
const LCM_LEDGER_MAINTENANCE_BYTES = 10 * 1024 ** 3;
export interface LedgerOptions { dbPath?: string; rootDir?: string; project?: ProjectIdentityInput; projectKey?: string; now?: () => number; warningBytes?: number; maintenanceBytes?: number }
export type OperationalState = "healthy" | "warning" | "maintenance" | "degraded";
export interface CheckpointMetrics { mode: "passive" | "truncate"; busy: number; logPages: number; checkpointedPages: number; truncated: boolean }
export interface BackupManifest { format: "lcm-ledger-backup"; version: number; source: string; destination: string; sourceSha256: string; backupSha256: string; sourceStateSha256: string; rowCounts: Record<string, number>; integrity: "ok" | string; createdAt: number }
type LcmSearchMode = "literal" | "phrase" | "regex";
export interface LcmSearchOptions { sessionId?: string; query?: string; mode: LcmSearchMode; offset: number; limit: number; scanLimit?: number; match?: "any" | "all" }
export interface LcmSearchPage { rows: RawEntry[]; total: number; scanned: number; complete: boolean }
export interface DeleteManifest { format: "lcm-ledger-delete"; version: number; projectKey: string; deletedAt: number; integrity: string; remaining: number; remainingByTable: Record<string, number>; unattributed: number; unattributedByTable: Record<string, number> }
export interface LedgerMigrationReport { version: number; name: string; applied: boolean; reason?: string; counts: Record<string, number> }
const LEDGER_SCHEMA_VERSION = 4;
const BACKUP_MANIFEST_VERSION = 3;
const DELETE_MANIFEST_VERSION = 2;
const PROJECT_KEYED_TABLES = ["projects", "project_aliases", "sessions", "raw_entries", "summary_nodes", "summary_node_revisions", "frontiers", "maintenance_jobs", "maintenance_usage", "repair_ladder"] as const;
const LCM_SEARCH_SCAN_LIMIT = 5_000;
const LCM_SCAN_BATCH = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (project_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_aliases (alias TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key));
CREATE TABLE IF NOT EXISTS sessions (project_key TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, session_id));
CREATE TABLE IF NOT EXISTS raw_entries (project_key TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, payload_json TEXT NOT NULL, parent_entry_id TEXT, branch TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, session_id, entry_id, revision), UNIQUE(project_key, session_id, entry_id, content_hash));
CREATE TABLE IF NOT EXISTS summary_nodes (node_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS summary_node_revisions (node_id TEXT NOT NULL REFERENCES summary_nodes(node_id), revision INTEGER NOT NULL, project_key TEXT NOT NULL, text TEXT NOT NULL, model_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(node_id, revision));
CREATE TABLE IF NOT EXISTS summary_edges (parent_id TEXT NOT NULL REFERENCES summary_nodes(node_id), child_id TEXT NOT NULL REFERENCES summary_nodes(node_id), PRIMARY KEY(parent_id, child_id));
CREATE TABLE IF NOT EXISTS frontiers (project_key TEXT NOT NULL, frontier_id TEXT NOT NULL, node_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, frontier_id, node_id));
CREATE TABLE IF NOT EXISTS maintenance_jobs (job_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance_usage (project_key TEXT NOT NULL, day TEXT NOT NULL, session_id TEXT NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost REAL NOT NULL, wall_ms INTEGER NOT NULL, PRIMARY KEY(project_key,day,session_id));
CREATE TABLE IF NOT EXISTS repair_ladder (project_key TEXT NOT NULL, fault TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(project_key, fault));
CREATE TABLE IF NOT EXISTS orphaned_rows (migration_version INTEGER NOT NULL, table_name TEXT NOT NULL, row_json TEXT NOT NULL, detected_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS raw_entries_lookup ON raw_entries(project_key, session_id, entry_id, revision);
DROP INDEX IF EXISTS raw_entries_recent;
CREATE INDEX IF NOT EXISTS raw_entries_session_order ON raw_entries(project_key, session_id, created_at, revision);
CREATE INDEX IF NOT EXISTS summary_nodes_order ON summary_nodes(project_key, created_at, node_id);
CREATE INDEX IF NOT EXISTS maintenance_jobs_status ON maintenance_jobs(project_key, status);
CREATE INDEX IF NOT EXISTS summary_edges_child ON summary_edges(child_id, parent_id);
`;

const fileHash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const snapshotHash = (db: SqliteDatabase): string => {
  const digest = crypto.createHash("sha256");
  for (const [table, order] of [["schema_metadata", "key"], ["projects", "project_key"], ["project_aliases", "alias"], ["sessions", "project_key,session_id"], ["raw_entries", "project_key,session_id,entry_id,revision"], ["summary_nodes", "node_id"], ["summary_edges", "parent_id,child_id"], ["frontiers", "project_key,frontier_id,node_id"], ["maintenance_jobs", "job_id"], ["maintenance_usage", "project_key,day,session_id"], ["repair_ladder", "project_key,fault"], ["orphaned_rows", "migration_version,table_name,row_json"]] as const) {
    digest.update(`${table}\0`);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()) digest.update(`${JSON.stringify(row)}\0`);
  }
  return digest.digest("hex");
};

const toRawEntry = (row: Record<string, unknown>): RawEntry => ({ projectKey: row.project_key as string, sessionId: row.session_id as string, entryId: row.entry_id as string, revision: Number(row.revision), role: row.role as string, content: row.content as string, contentHash: row.content_hash as string, payloadHash: row.content_hash as string, payloadJson: row.payload_json as string, parentEntryId: row.parent_entry_id as string | null, branch: row.branch as string | null, createdAt: row.created_at as number });
const toRawEntries = (rows: unknown[]): RawEntry[] => (rows as Array<Record<string, unknown>>).map(toRawEntry);

const probeFts5 = (db: SqliteDatabase): boolean => {
  try { db.exec("CREATE VIRTUAL TABLE temp.lcm_fts5_probe USING fts5(probe); DROP TABLE temp.lcm_fts5_probe;"); return true; }
  catch { try { db.exec("DROP TABLE IF EXISTS temp.lcm_fts5_probe"); } catch {} return false; }
};

const foldToken = (value: string): string => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const tokenize = (value: string): string[] => value.split(/[^\p{L}\p{N}]+/u).map(foldToken).filter(token => token.length > 0);
const searchPhrases = (query: string, mode: LcmSearchMode): string[][] =>
  (mode === "phrase" ? [query] : query.split(/\s+/)).map(tokenize).filter(phrase => phrase.length > 0);
const ftsExpression = (phrases: string[][], match: "any" | "all"): string =>
  phrases.map(phrase => `"${phrase.join(" ")}"`).join(match === "all" ? " AND " : " OR ");
const containsPhrase = (tokens: string[], phrase: string[]): boolean => {
  for (let start = 0; start + phrase.length <= tokens.length; start++) {
    let hit = true;
    for (let offset = 0; offset < phrase.length; offset++) if (tokens[start + offset] !== phrase[offset]) { hit = false; break; }
    if (hit) return true;
  }
  return false;
};
const phrasePredicate = (phrases: string[][], match: "any" | "all"): (content: string) => boolean =>
  match === "all"
    ? content => { const tokens = tokenize(content); return phrases.every(phrase => containsPhrase(tokens, phrase)); }
    : content => { const tokens = tokenize(content); return phrases.some(phrase => containsPhrase(tokens, phrase)); };

class LedgerDegradedError extends Error { constructor(message: string, public readonly cause?: unknown) { super(message); this.name = "LedgerDegradedError"; } }

export class LcmLedger {
  readonly db: SqliteDatabase;
  readonly project: ProjectIdentity;
  private degraded = false;
  private readonly dbPath: string;
  private readonly now: () => number;
  private readonly warningBytes: number;
  private readonly maintenanceBytes: number;
  private writeChain: Promise<void> = Promise.resolve();
  private transactionDepth = 0;
  private closed = false;
  private fts = false;
  readonly migrations: LedgerMigrationReport[] = [];
  constructor(options: LedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.warningBytes = options.warningBytes ?? LCM_LEDGER_WARNING_BYTES;
    this.maintenanceBytes = options.maintenanceBytes ?? LCM_LEDGER_MAINTENANCE_BYTES;
    if (!Number.isSafeInteger(this.warningBytes) || !Number.isSafeInteger(this.maintenanceBytes) || this.warningBytes < 0 || this.maintenanceBytes < this.warningBytes) {
      throw new Error("invalid ledger size thresholds");
    }
    const identity = canonicalProjectIdentity(options.project ?? { liveCwd: process.cwd() });
    const adopted = options.projectKey
      ?? (options.dbPath ? identity.key : stableProjectKey(options.rootDir ?? defaultLedgerRoot(), identity, this.now()));
    this.project = adopted === identity.key ? identity : { ...identity, key: adopted };
    const dbPath = options.dbPath ?? defaultLedgerPath(options.rootDir, this.project.key);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new (sqliteDriver())(dbPath);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000;");
      this.db.exec("BEGIN IMMEDIATE;" + SCHEMA + "COMMIT;");
      const columns = this.db.prepare("PRAGMA table_info(raw_entries)").all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === "payload_json")) {
        if (Number((this.db.prepare("SELECT count(*) n FROM raw_entries").get() as { n: number }).n)) throw new Error("raw payloads missing; reimport authoritative session entries");
        this.db.exec("ALTER TABLE raw_entries ADD COLUMN payload_json TEXT NOT NULL DEFAULT ''");
      }
      this.fts = probeFts5(this.db);
      this.migrateSchema();
      this.db.exec("PRAGMA foreign_keys=ON");
      const result = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (result.integrity_check !== "ok") throw new Error(String(result.integrity_check));
      this.registerProject(this.project);
    } catch (error) { this.degraded = true; throw new LedgerDegradedError("ledger startup failed", error); }
  }
  readRepairLadder(projectKey = this.project.key): Map<string, { attempts: number; nextAt: number; detail: string; updatedAt: number }> {
    return this.readOnly(db => new Map((db.prepare("SELECT fault,attempts,next_at,detail,updated_at FROM repair_ladder WHERE project_key=?").all(projectKey) as Array<{ fault: string; attempts: number; next_at: number; detail: string; updated_at: number }>).map(row => [row.fault, { attempts: Number(row.attempts), nextAt: Number(row.next_at), detail: row.detail, updatedAt: Number(row.updated_at) }])));
  }
  writeRepairLadder(fault: string, attempts: number, nextAt: number, detail: string): void {
    this.transaction(db => db.prepare("INSERT INTO repair_ladder(project_key,fault,attempts,next_at,updated_at,detail) VALUES(?,?,?,?,?,?) ON CONFLICT(project_key,fault) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,updated_at=excluded.updated_at,detail=excluded.detail").run(this.project.key, fault, attempts, nextAt, this.now(), detail));
  }
  clearRepairLadder(fault: string): void {
    this.transaction(db => db.prepare("DELETE FROM repair_ladder WHERE project_key=? AND fault=?").run(this.project.key, fault));
  }
  get isDegraded() { return this.degraded; }
  get file(): string { return this.dbPath; }
  get bytes(): number { try { return fs.statSync(this.dbPath).size; } catch { return 0; } }
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
  get ftsAvailable() { return this.fts; }
  private schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM schema_metadata WHERE key='version'").get() as { value?: string } | undefined;
    const version = Number(row?.value ?? 0);
    return Number.isSafeInteger(version) && version > 0 ? version : 0;
  }
  private hasObject(type: string, name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get(type, name) !== undefined;
  }
  private indexOutOfStep(): boolean {
    if (this.fts !== this.hasObject("table", "raw_entries_fts")) return true;
    if (!this.fts) return false;
    if (!this.hasObject("trigger", "raw_entries_fts_insert")) return true;
    return Number((this.db.prepare("SELECT count(*) n FROM raw_entries_fts").get() as { n: number }).n) !== Number((this.db.prepare("SELECT count(*) n FROM raw_entries").get() as { n: number }).n);
  }
  private migrateSchema(): void {
    const version = this.schemaVersion();
    if (version < 2 || this.indexOutOfStep()) this.migrations.push(this.migrateFullTextIndex());
    if (version < 3 || (this.db.prepare("PRAGMA foreign_key_list(summary_edges)").all().length === 0)) this.migrations.push(this.migrateDerivedForeignKeys());
    if (version !== LEDGER_SCHEMA_VERSION) this.db.prepare("INSERT INTO schema_metadata(key,value) VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(LEDGER_SCHEMA_VERSION));
  }
  private migrateFullTextIndex(): LedgerMigrationReport {
    if (!this.fts) {
      this.db.exec("DROP TRIGGER IF EXISTS raw_entries_fts_insert");
      return { version: 2, name: "raw-entries-fts", applied: false, reason: "sqlite driver has no fts5 module", counts: { indexed: 0 } };
    }
    let indexed = 0;
    this.transaction(db => {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS raw_entries_fts USING fts5(content, project_key UNINDEXED, session_id UNINDEXED, entry_id UNINDEXED, revision UNINDEXED)");
      db.exec("CREATE TRIGGER IF NOT EXISTS raw_entries_fts_insert AFTER INSERT ON raw_entries BEGIN INSERT INTO raw_entries_fts(content,project_key,session_id,entry_id,revision) VALUES(new.content,new.project_key,new.session_id,new.entry_id,new.revision); END");
      indexed = Number((db.prepare("SELECT count(*) n FROM raw_entries").get() as { n: number }).n);
      if (Number((db.prepare("SELECT count(*) n FROM raw_entries_fts").get() as { n: number }).n) === indexed) return;
      db.exec("DELETE FROM raw_entries_fts");
      db.exec("INSERT INTO raw_entries_fts(content,project_key,session_id,entry_id,revision) SELECT content,project_key,session_id,entry_id,revision FROM raw_entries");
    });
    return { version: 2, name: "raw-entries-fts", applied: true, counts: { indexed } };
  }
  private migrateDerivedForeignKeys(): LedgerMigrationReport {
    const counts: Record<string, number> = { summary_edges: 0, summary_node_revisions: 0 };
    this.transaction(db => {
      const detectedAt = this.now();
      const known = "(SELECT node_id FROM summary_nodes)";
      const quarantine = (table: string, orphaned: string): void => {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE ${orphaned}`).all() as Array<Record<string, unknown>>;
        for (const row of rows) db.prepare("INSERT INTO orphaned_rows(migration_version,table_name,row_json,detected_at) VALUES(?,?,?,?)").run(LEDGER_SCHEMA_VERSION, table, JSON.stringify(row), detectedAt);
        counts[table] = rows.length;
      };
      quarantine("summary_edges", `parent_id NOT IN ${known} OR child_id NOT IN ${known}`);
      db.exec(`CREATE TABLE summary_edges_next (parent_id TEXT NOT NULL REFERENCES summary_nodes(node_id), child_id TEXT NOT NULL REFERENCES summary_nodes(node_id), PRIMARY KEY(parent_id, child_id));
INSERT INTO summary_edges_next(parent_id,child_id) SELECT parent_id,child_id FROM summary_edges WHERE parent_id IN ${known} AND child_id IN ${known};
DROP TABLE summary_edges;
ALTER TABLE summary_edges_next RENAME TO summary_edges;`);
      quarantine("summary_node_revisions", `node_id NOT IN ${known}`);
      db.exec(`CREATE TABLE summary_node_revisions_next (node_id TEXT NOT NULL REFERENCES summary_nodes(node_id), revision INTEGER NOT NULL, project_key TEXT NOT NULL, text TEXT NOT NULL, model_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(node_id, revision));
INSERT INTO summary_node_revisions_next(node_id,revision,project_key,text,model_hash,created_at) SELECT node_id,revision,project_key,text,model_hash,created_at FROM summary_node_revisions WHERE node_id IN ${known};
DROP TABLE summary_node_revisions;
ALTER TABLE summary_node_revisions_next RENAME TO summary_node_revisions;`);
    });
    return { version: 3, name: "derived-foreign-keys", applied: true, counts };
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
  readRaw(projectKey = this.project.key, sessionId?: string): RawEntry[] { this.guard(); this.assertProjectKey(projectKey); const rows = sessionId ? this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at,revision,rowid").all(projectKey,sessionId) : this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? ORDER BY created_at,session_id,entry_id,revision").all(projectKey); return toRawEntries(rows); }
  readRawPage(projectKey = this.project.key, sessionId?: string, offset = 0, limit = 100): RawEntry[] { if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid raw page"); this.guard(); this.assertProjectKey(projectKey); const rows = sessionId ? this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at,revision,rowid LIMIT ? OFFSET ?").all(projectKey,sessionId,limit,offset) : this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? ORDER BY created_at,session_id,entry_id,revision LIMIT ? OFFSET ?").all(projectKey,limit,offset); return toRawEntries(rows); }
  readRawEntry(projectKey: string, sessionId: string, entryId: string, revision: number): RawEntry | undefined { this.guard(); this.assertProjectKey(projectKey); const row = this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND revision=?").get(projectKey,sessionId,entryId,revision) as Record<string, unknown> | undefined; return row ? toRawEntry(row) : undefined; }
  searchRaw(projectKey: string | undefined, options: LcmSearchOptions): LcmSearchPage {
    this.guard();
    const key = projectKey ?? this.project.key;
    this.assertProjectKey(key);
    const { offset, limit, sessionId } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid raw page");
    const scanLimit = options.scanLimit ?? LCM_SEARCH_SCAN_LIMIT;
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1) throw new Error("invalid scan limit");
    const query = options.query?.trim() ?? "";
    if (query.length === 0) return this.recentPage(key, sessionId, offset, limit);
    if (options.mode === "regex") {
      let pattern: RegExp;
      try { pattern = new RegExp(query, "iu"); } catch { return { rows: [], total: 0, scanned: 0, complete: false }; }
      return this.scanPage(key, sessionId, content => pattern.test(content), offset, limit, scanLimit, false);
    }
    const match = options.match ?? "any";
    const phrases = searchPhrases(query, options.mode);
    if (phrases.length === 0) return { rows: [], total: 0, scanned: 0, complete: true };
    if (this.fts) { try { return this.indexPage(key, sessionId, ftsExpression(phrases, match), offset, limit); } catch {} }
    return this.scanPage(key, sessionId, phrasePredicate(phrases, match), offset, limit, scanLimit, true);
  }
  private recentPage(key: string, sessionId: string | undefined, offset: number, limit: number): LcmSearchPage {
    const counted = (sessionId
      ? this.db.prepare("SELECT count(*) n FROM raw_entries WHERE project_key=? AND session_id=?").get(key, sessionId)
      : this.db.prepare("SELECT count(*) n FROM raw_entries WHERE project_key=?").get(key)) as { n: number };
    const total = Number(counted.n);
    const rows = sessionId
      ? this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at DESC, revision DESC, rowid DESC LIMIT ? OFFSET ?").all(key, sessionId, limit, offset)
      : this.db.prepare("SELECT * FROM raw_entries WHERE project_key=? ORDER BY created_at DESC, revision DESC, rowid DESC LIMIT ? OFFSET ?").all(key, limit, offset);
    return { rows: toRawEntries(rows), total, scanned: total, complete: true };
  }
  private indexPage(key: string, sessionId: string | undefined, expression: string, offset: number, limit: number): LcmSearchPage {
    const source = "FROM raw_entries_fts JOIN raw_entries r ON r.project_key=raw_entries_fts.project_key AND r.session_id=raw_entries_fts.session_id AND r.entry_id=raw_entries_fts.entry_id AND r.revision=CAST(raw_entries_fts.revision AS INTEGER) WHERE raw_entries_fts MATCH ? AND raw_entries_fts.project_key=?" + (sessionId ? " AND raw_entries_fts.session_id=?" : "");
    const filters = sessionId ? [expression, key, sessionId] : [expression, key];
    const total = Number((this.db.prepare(`SELECT count(*) n ${source}`).get(...filters) as { n: number }).n);
    const rows = this.db.prepare(`SELECT r.* ${source} ORDER BY r.created_at DESC, r.revision DESC, r.rowid DESC LIMIT ? OFFSET ?`).all(...filters, limit, offset);
    return { rows: toRawEntries(rows), total, scanned: total, complete: true };
  }
  private scanPage(key: string, sessionId: string | undefined, matches: (content: string) => boolean, offset: number, limit: number, scanLimit: number, degraded: boolean): LcmSearchPage {
    const statement = sessionId
      ? this.db.prepare("SELECT session_id,entry_id,revision,content FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at DESC, revision DESC, rowid DESC LIMIT ? OFFSET ?")
      : this.db.prepare("SELECT session_id,entry_id,revision,content FROM raw_entries WHERE project_key=? ORDER BY created_at DESC, revision DESC, rowid DESC LIMIT ? OFFSET ?");
    const found: Array<{ sessionId: string; entryId: string; revision: number }> = [];
    let scanned = 0;
    let exhausted = false;
    while (scanned < scanLimit) {
      const size = Math.min(LCM_SCAN_BATCH, scanLimit - scanned);
      const batch = (sessionId ? statement.all(key, sessionId, size, scanned) : statement.all(key, size, scanned)) as Array<Record<string, unknown>>;
      scanned += batch.length;
      for (const row of batch) if (matches(row.content as string)) found.push({ sessionId: row.session_id as string, entryId: row.entry_id as string, revision: Number(row.revision) });
      if (batch.length < size) { exhausted = true; break; }
    }
    const rows: RawEntry[] = [];
    for (const identity of found.slice(offset, offset + limit)) {
      const entry = this.readRawEntry(key, identity.sessionId, identity.entryId, identity.revision);
      if (entry) rows.push(entry);
    }
    return { rows, total: found.length, scanned, complete: degraded ? false : exhausted };
  }
  /** Identity columns only, so a coverage scan never loads payloads. */
  readRawKeys(projectKey = this.project.key, sessionId?: string, limit = 100_000): Array<{ sessionId: string; entryId: string; revision: number }> {
    this.guard(); this.assertProjectKey(projectKey);
    const rows = sessionId
      ? this.db.prepare("SELECT session_id, entry_id, revision FROM raw_entries WHERE project_key=? AND session_id=? ORDER BY created_at,revision,rowid LIMIT ?").all(projectKey, sessionId, limit)
      : this.db.prepare("SELECT session_id, entry_id, revision FROM raw_entries WHERE project_key=? ORDER BY created_at,session_id,entry_id,revision LIMIT ?").all(projectKey, limit);
    return (rows as Array<Record<string, unknown>>).map(row => ({ sessionId: row.session_id as string, entryId: row.entry_id as string, revision: Number(row.revision) }));
  }
  /** Total stored payload bytes for one session, as a single aggregate. */
  payloadBytes(projectKey = this.project.key, sessionId?: string): number {
    this.guard(); this.assertProjectKey(projectKey);
    const row = sessionId
      ? this.db.prepare("SELECT coalesce(sum(length(payload_json)),0) n FROM raw_entries WHERE project_key=? AND session_id=?").get(projectKey, sessionId)
      : this.db.prepare("SELECT coalesce(sum(length(payload_json)),0) n FROM raw_entries WHERE project_key=?").get(projectKey);
    return Number((row as { n: number }).n);
  }
  readOnly<T>(fn: (db: SqliteDatabase) => T): T { this.guard(); return fn(this.db); }
  transaction<T>(fn: (db: SqliteDatabase) => T): T { this.guard(); if (this.transactionDepth > 0) return fn(this.db); this.db.exec("BEGIN IMMEDIATE"); this.transactionDepth = 1; try { const result = fn(this.db); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } finally { this.transactionDepth = 0; } }
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
      const copy = new (sqliteDriver())(target);
      let integrity = "unknown";
      let backupStateSha256 = "";
      const rowCounts: Record<string, number> = {};
      try {
        integrity = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check ?? "unknown";
        for (const table of ["projects", "sessions", "raw_entries", "summary_nodes", "summary_node_revisions", "summary_edges", "frontiers", "maintenance_jobs", "maintenance_usage", "repair_ladder", "orphaned_rows"]) {
          rowCounts[table] = Number((copy.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n);
        }
        backupStateSha256 = snapshotHash(copy);
      } finally {
        copy.close();
      }
      const manifest: BackupManifest = { format: "lcm-ledger-backup", version: BACKUP_MANIFEST_VERSION, source: this.dbPath, destination: target, sourceSha256: fileHash(this.dbPath), backupSha256: fileHash(target), sourceStateSha256: backupStateSha256, rowCounts, integrity, createdAt: this.now() };
      fs.writeFileSync(`${target}.manifest.json`, JSON.stringify(manifest), { mode: 0o600 });
      fs.chmodSync(`${target}.manifest.json`, 0o600);
      return manifest;
    });
  }
  exportBackup(destination: string): BackupManifest { return this.backup(destination); }
  private orphanOwner(db: SqliteDatabase, rowJson: string): string | undefined {
    let row: Record<string, unknown>;
    try { row = JSON.parse(rowJson) as Record<string, unknown>; } catch { return undefined; }
    if (typeof row.project_key === "string") return row.project_key;
    for (const column of ["node_id", "parent_id", "child_id"]) {
      const nodeId = row[column];
      if (typeof nodeId !== "string") continue;
      const owner = db.prepare("SELECT project_key FROM summary_nodes WHERE node_id=?").get(nodeId) as { project_key?: string } | undefined;
      if (owner?.project_key !== undefined) return owner.project_key;
    }
    return undefined;
  }
  private projectFootprint(): { remaining: Record<string, number>; unattributed: Record<string, number> } {
    const key = this.project.key;
    const count = (sql: string, ...params: unknown[]): number => Number((this.db.prepare(sql).get(...params) as { n: number }).n);
    const remaining: Record<string, number> = {};
    for (const table of PROJECT_KEYED_TABLES) remaining[table] = count(`SELECT count(*) n FROM ${table} WHERE project_key=?`, key);
    remaining.summary_edges = count("SELECT count(*) n FROM summary_edges WHERE parent_id IN (SELECT node_id FROM summary_nodes WHERE project_key=?) OR child_id IN (SELECT node_id FROM summary_nodes WHERE project_key=?)", key, key);
    if (this.fts) remaining.raw_entries_fts = count("SELECT count(*) n FROM raw_entries_fts WHERE project_key=?", key);
    const unattributed: Record<string, number> = {};
    remaining.orphaned_rows = 0;
    for (const row of this.db.prepare("SELECT row_json FROM orphaned_rows").all() as Array<{ row_json: string }>) {
      const owner = this.orphanOwner(this.db, row.row_json);
      if (owner === key) remaining.orphaned_rows++;
      else if (owner === undefined) unattributed.orphaned_rows = (unattributed.orphaned_rows ?? 0) + 1;
    }
    const dangling = count("SELECT count(*) n FROM summary_edges WHERE parent_id NOT IN (SELECT node_id FROM summary_nodes) OR child_id NOT IN (SELECT node_id FROM summary_nodes)");
    if (dangling > 0) unattributed.summary_edges = dangling;
    return { remaining, unattributed };
  }
  deleteProject(token: DeleteConfirmationToken, backupManifest: BackupManifest): void {
    this.guard();
    if (token.__brand !== "DeleteConfirmationToken" || token.projectKey !== this.project.key || token.value !== hash(`delete:${this.project.key}`)) throw new Error("invalid delete confirmation token");
    if (backupManifest.version !== BACKUP_MANIFEST_VERSION) throw new Error(`backup manifest version ${backupManifest.version} predates this ledger (expected ${BACKUP_MANIFEST_VERSION}); take a fresh backup`);
    const backupDb = fs.existsSync(backupManifest.destination) ? new (sqliteDriver())(backupManifest.destination) : undefined;
    let backupStateSha256: string | undefined;
    try {
      if (backupDb) backupStateSha256 = snapshotHash(backupDb);
    } finally {
      backupDb?.close();
    }
    if (backupManifest.integrity !== "ok" || backupManifest.source !== this.dbPath || !backupManifest.backupSha256 || backupManifest.backupSha256 !== fileHash(backupManifest.destination) || !backupManifest.sourceStateSha256 || backupManifest.sourceStateSha256 !== backupStateSha256 || backupManifest.sourceSha256 !== fileHash(this.dbPath) || backupManifest.sourceStateSha256 !== snapshotHash(this.db)) throw new Error("backup verification failed");
    this.transaction(db => {
      const purge = db.prepare("DELETE FROM orphaned_rows WHERE rowid=?");
      for (const row of db.prepare("SELECT rowid AS id, row_json FROM orphaned_rows").all() as Array<{ id: number; row_json: string }>) {
        if (this.orphanOwner(db, row.row_json) === this.project.key) purge.run(row.id);
      }
      db.prepare("DELETE FROM summary_edges WHERE parent_id IN (SELECT node_id FROM summary_nodes WHERE project_key=?) OR child_id IN (SELECT node_id FROM summary_nodes WHERE project_key=?)").run(this.project.key, this.project.key);
      for (const table of ["raw_entries", "sessions", "frontiers", "summary_node_revisions", "summary_nodes", "maintenance_jobs", "maintenance_usage", "repair_ladder"]) db.prepare(`DELETE FROM ${table} WHERE project_key=?`).run(this.project.key);
      if (this.fts) db.prepare("DELETE FROM raw_entries_fts WHERE project_key=?").run(this.project.key);
      db.prepare("DELETE FROM project_aliases WHERE project_key=?").run(this.project.key);
      db.prepare("DELETE FROM projects WHERE project_key=?").run(this.project.key);
    });
    const integrity = (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check;
    if (integrity !== "ok") throw new Error(`post-delete integrity failed: ${integrity}`);
    const footprint = this.projectFootprint();
    const total = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, value) => sum + value, 0);
    const audit: DeleteManifest = { format: "lcm-ledger-delete", version: DELETE_MANIFEST_VERSION, projectKey: this.project.key, deletedAt: this.now(), integrity, remaining: total(footprint.remaining), remainingByTable: footprint.remaining, unattributed: total(footprint.unattributed), unattributedByTable: footprint.unattributed };
    fs.writeFileSync(`${backupManifest.destination}.delete-manifest.json`, JSON.stringify(audit), { mode: 0o600 });
  }
  private serializeSync<T>(operation: () => T): T { this.guard(); return operation(); }
  close() { if (this.closed) return; this.db.close(); this.closed = true; }
}
