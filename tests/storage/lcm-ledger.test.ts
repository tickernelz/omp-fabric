import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createDeleteConfirmationToken, canonicalProjectIdentity, hashLcmPayload } from "../../src/storage/lcm-ledger.js";
import { setSqliteDriver, sqliteDriver, type SqliteDriver } from "../../src/storage/sqlite.js";
import { openLedger, releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";

const LEGACY_SCHEMA = `
CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (project_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE project_aliases (alias TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key));
CREATE TABLE sessions (project_key TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, session_id));
CREATE TABLE raw_entries (project_key TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, payload_json TEXT NOT NULL, parent_entry_id TEXT, branch TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, session_id, entry_id, revision), UNIQUE(project_key, session_id, entry_id, content_hash));
CREATE TABLE summary_nodes (node_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE summary_node_revisions (node_id TEXT NOT NULL, revision INTEGER NOT NULL, project_key TEXT NOT NULL, text TEXT NOT NULL, model_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(node_id, revision));
CREATE TABLE summary_edges (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY(parent_id, child_id));
CREATE TABLE frontiers (project_key TEXT NOT NULL, frontier_id TEXT NOT NULL, node_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_key, frontier_id, node_id));
CREATE TABLE maintenance_jobs (job_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE maintenance_usage (project_key TEXT NOT NULL, day TEXT NOT NULL, session_id TEXT NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost REAL NOT NULL, wall_ms INTEGER NOT NULL, PRIMARY KEY(project_key,day,session_id));
CREATE INDEX raw_entries_lookup ON raw_entries(project_key, session_id, entry_id, revision);
INSERT INTO schema_metadata(key,value) VALUES('version','1');
`;

const legacyLedger = (dbPath: string, projectKey: string, contents: string[]): void => {
  const db = new (sqliteDriver())(dbPath);
  db.exec(LEGACY_SCHEMA);
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO raw_entries(project_key,session_id,entry_id,revision,role,content,content_hash,payload_json,parent_entry_id,branch,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)");
  contents.forEach((content, index) => {
    const payload = JSON.stringify({ type: "message", id: `legacy${index}`, role: "user", content });
    insert.run(projectKey, "s1", `legacy${index}`, 1, "user", content, hashLcmPayload(JSON.parse(payload) as Record<string, unknown>), payload, 1_000 + index);
  });
  db.exec("COMMIT");
  db.close();
};

const make = () => tempRoot("lcm-ledger-");
afterEach(releaseTemp);
const entry = (projectKey: string, content: string, entryId = "e1") => ({ projectKey, sessionId: "s1", entryId, role: "user", content, payloadJson: JSON.stringify({ type: "message", id: entryId, role: "user", content, parentId: null, branchId: "main", timestamp: 1 }) });

describe("LCM ledger", () => {
  it("is idempotent and creates immutable revisions", () => { const d = make(); const l = openLedger({ dbPath: path.join(d,"a.sqlite"), project: { liveCwd: d } }); const a = l.appendRaw(entry(l.project.key,"one")); expect(l.appendRaw(entry(l.project.key,"one"))).toEqual(a); const b = l.appendRaw(entry(l.project.key,"two")); expect(b.revision).toBe(2); expect(l.readRaw()).toHaveLength(2); l.close(); });
  it("hashes the full canonical payload, not derived content", () => { const d = make(); const l = openLedger({ dbPath: path.join(d,"a.sqlite"), project: { liveCwd: d } }); const first = l.appendRaw(entry(l.project.key,"same","e1")); const second = l.appendRaw({ ...entry(l.project.key,"same","e1"), payloadJson: JSON.stringify({ timestamp: 2, content: "same", role: "user", id: "e1", type: "message" }) }); expect(second.revision).toBe(2); expect(first.payloadHash).toBe(hashLcmPayload(JSON.parse(first.payloadJson))); expect(second.payloadHash).not.toBe(first.payloadHash); l.close(); });
  it("rolls back an append batch atomically and preserves restart integrity", () => { const d=make(); const p=path.join(d,"a.sqlite"); let l=openLedger({dbPath:p,project:{liveCwd:d}}); expect(() => l.transaction(() => { l.appendRaw(entry(l.project.key,"first","e1")); l.appendRaw(entry(l.project.key,"second","e2")); throw new Error("batch abort"); })).toThrow("batch abort"); expect(l.readRaw()).toHaveLength(0); l.close(); l=openLedger({dbPath:p,project:{liveCwd:d}}); const saved=l.appendRaw(entry(l.project.key,"persisted","e1")); l.close(); l=openLedger({dbPath:p,project:{liveCwd:d}}); expect(l.readRaw()).toHaveLength(1); expect(l.readRaw()[0]).toMatchObject(saved); l.close(); });
  it("rolls back transaction primitives and reopens", () => { const d = make(); const p = path.join(d,"a.sqlite"); let l = openLedger({ dbPath:p, project:{liveCwd:d}}); expect(() => l.transaction(db => { db.prepare("INSERT INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run("n",l.project.key,"x",Date.now()); throw new Error("abort"); })).toThrow("abort"); l.close(); l = openLedger({dbPath:p,project:{liveCwd:d}}); expect((l.db.prepare("SELECT count(*) n FROM summary_nodes").get() as {n:number}).n).toBe(0); l.close(); });
  it("uses recorded cwd and converges aliases while separating worktrees", () => { const d=make(); const real=path.join(d,"real"); fs.mkdirSync(real); const alias=path.join(d,"alias"); fs.symlinkSync(real,alias); expect(canonicalProjectIdentity({recordedCwd:alias,liveCwd:"/nope"}).key).toBe(canonicalProjectIdentity({liveCwd:real}).key); const other=path.join(d,"other"); fs.mkdirSync(other); expect(canonicalProjectIdentity({liveCwd:other}).key).not.toBe(canonicalProjectIdentity({liveCwd:real}).key); });
  it("rejects missing entry IDs", () => { const d=make(); const l=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d}}); expect(() => l.appendRaw({projectKey:l.project.key,sessionId:"s",entryId:"  ",role:"user",content:"x",payloadJson: JSON.stringify({ type: "message", id: "  ", role: "user", content: "x" })})).toThrow("entry ID is required"); expect(l.readRaw()).toHaveLength(0); l.close(); });
  it("serializes concurrent appends", async () => { const d=make(); const l=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d}}); const out=await Promise.all(Array.from({length:8},(_,i)=>l.serialize(()=>l.appendRaw(entry(l.project.key,String(i),`e${i}`))))); expect(out).toHaveLength(8); expect(l.readRaw()).toHaveLength(8); l.close(); });
  it("rejects cross-project raw reads", () => { const d=make(); const l=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d}}); const stored=l.appendRaw(entry(l.project.key,"session")); expect(() => l.readRaw("other-project")).toThrow("project key does not match ledger project"); expect(() => l.readRawPage("other-project")).toThrow("project key does not match ledger project"); expect(() => l.readRawEntry("other-project",stored.sessionId,stored.entryId,stored.revision)).toThrow("project key does not match ledger project"); l.close(); });
  it("reports checkpoint mode and operational state", () => { const d=make(); const l=openLedger({dbPath:path.join(d,"a.sqlite"),project:{liveCwd:d},warningBytes:1,maintenanceBytes:2}); const passive=l.checkpoint(); expect(passive.mode).toBe("passive"); expect(passive.busy).toBeGreaterThanOrEqual(0); expect(passive.logPages).toBeGreaterThanOrEqual(0); expect(passive.checkpointedPages).toBeGreaterThanOrEqual(0); expect(passive.truncated).toBe(false); const truncate=l.checkpoint("truncate"); expect(truncate.mode).toBe("truncate"); expect(truncate.truncated).toBe(truncate.busy === 0 && truncate.logPages === 0); expect(l.operationalState).toBe("maintenance"); l.markDegraded(); expect(l.operationalState).toBe("degraded"); expect(() => l.readRaw()).toThrow("ledger is degraded"); l.close(); });
  it("deletes project-owned edges and usage after verified backup", () => { const d=make(); const db=path.join(d,"a.sqlite"); const backup=path.join(d,"backup.sqlite"); const l=openLedger({dbPath:db,project:{liveCwd:d}}); l.appendRaw(entry(l.project.key,"keep")); l.transaction(database => { database.prepare("INSERT INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run("n1",l.project.key,"{}",1); database.prepare("INSERT INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run("n2",l.project.key,"{}",1); database.prepare("INSERT INTO summary_edges(parent_id,child_id) VALUES(?,?)").run("n2","n1"); database.prepare("INSERT INTO maintenance_usage(project_key,day,session_id,calls,input_tokens,output_tokens,cost,wall_ms) VALUES(?,?,?,?,?,?,?,?)").run(l.project.key,"2026-09-01","s1",1,2,3,0,4); }); const manifest=l.backup(backup); l.deleteProject(createDeleteConfirmationToken(l.project.key),manifest); expect((l.db.prepare("SELECT count(*) n FROM summary_edges").get() as {n:number}).n).toBe(0); expect((l.db.prepare("SELECT count(*) n FROM maintenance_usage").get() as {n:number}).n).toBe(0); expect((l.db.prepare("SELECT count(*) n FROM projects").get() as {n:number}).n).toBe(0); l.close(); });
  it("creates a verified backup and requires a typed delete token", () => { const d=make(); const db=path.join(d,"a.sqlite"); const backup=path.join(d,"backup.sqlite"); const l=openLedger({dbPath:db,project:{liveCwd:d}}); l.appendRaw(entry(l.project.key,"keep")); const manifest=l.backup(backup); expect(manifest.format).toBe("lcm-ledger-backup"); expect(manifest.version).toBe(1); expect(manifest.integrity).toBe("ok"); expect(manifest.rowCounts.raw_entries).toBe(1); expect(manifest.rowCounts.maintenance_usage).toBe(0); if (process.platform !== "win32") { expect(fs.statSync(backup).mode & 0o777).toBe(0o600); expect(fs.statSync(`${backup}.manifest.json`).mode & 0o777).toBe(0o600); } expect(() => l.deleteProject({projectKey:l.project.key,value:"bad",__brand:"DeleteConfirmationToken"},manifest)).toThrow("invalid delete confirmation token"); l.deleteProject(createDeleteConfirmationToken(l.project.key),manifest); expect(l.readRaw()).toHaveLength(0); expect(fs.existsSync(`${backup}.delete-manifest.json`)).toBe(true); l.close(); });
  it("rejects deletion after a post-backup WAL write", () => { const d=make(); const db=path.join(d,"a.sqlite"); const backup=path.join(d,"backup.sqlite"); const l=openLedger({dbPath:db,project:{liveCwd:d}}); l.appendRaw(entry(l.project.key,"before")); const manifest=l.backup(backup); l.appendRaw(entry(l.project.key,"after")); expect(() => l.deleteProject(createDeleteConfirmationToken(l.project.key),manifest)).toThrow("backup verification failed"); l.close(); });
  it("finds a term only the newest entry of a large session carries, newest first", () => {
    const d = make(); const l = openLedger({ dbPath: path.join(d, "a.sqlite"), project: { liveCwd: d } });
    l.transaction(() => { for (let i = 0; i < 1200; i++) l.appendRaw({ ...entry(l.project.key, i === 1199 ? "zebraflux marker" : `ordinary ${i}`, `e${i}`), createdAt: 1_000 + i }); });
    const page = l.searchRaw(undefined, { sessionId: "s1", query: "zebraflux", mode: "literal", offset: 0, limit: 10 });
    expect(page.rows.map(row => row.entryId)).toEqual(["e1199"]);
    expect(page.total).toBe(1);
    expect(page.complete).toBe(true);
    expect(page.scanned).toBe(page.total);
    const recent = l.searchRaw(undefined, { sessionId: "s1", mode: "literal", offset: 0, limit: 3 });
    expect(recent.rows.map(row => row.entryId)).toEqual(["e1199", "e1198", "e1197"]);
    expect(recent.total).toBe(1200);
    expect(recent.complete).toBe(true);
  });
  it("treats full-text operators in a query as text instead of syntax", () => {
    const d = make(); const l = openLedger({ dbPath: path.join(d, "a.sqlite"), project: { liveCwd: d } });
    l.appendRaw(entry(l.project.key, 'release NEAR* notes OR draft -x "quoted', "e1"));
    l.appendRaw(entry(l.project.key, "unrelated body", "e2"));
    const all = l.searchRaw(undefined, { query: 'NEAR* -x "quoted', mode: "literal", match: "all", offset: 0, limit: 5 });
    expect(all.rows.map(row => row.entryId)).toEqual(["e1"]);
    expect(all.complete).toBe(true);
    const any = l.searchRaw(undefined, { query: "NEAR* unrelated", mode: "literal", offset: 0, limit: 5 });
    expect(any.rows.map(row => row.entryId).sort()).toEqual(["e1", "e2"]);
    const phrase = l.searchRaw(undefined, { query: "notes OR draft", mode: "phrase", offset: 0, limit: 5 });
    expect(phrase.rows.map(row => row.entryId)).toEqual(["e1"]);
  });
  it("answers a malformed regex with an incomplete empty page and caps a scan", () => {
    const d = make(); const l = openLedger({ dbPath: path.join(d, "a.sqlite"), project: { liveCwd: d } });
    l.transaction(() => { l.appendRaw({ ...entry(l.project.key, "alpha target", "e1"), createdAt: 1 }); l.appendRaw({ ...entry(l.project.key, "beta", "e2"), createdAt: 2 }); });
    expect(l.searchRaw(undefined, { query: "a(", mode: "regex", offset: 0, limit: 5 })).toEqual({ rows: [], total: 0, scanned: 0, complete: false });
    const found = l.searchRaw(undefined, { query: "tar.et", mode: "regex", offset: 0, limit: 5 });
    expect(found.rows.map(row => row.entryId)).toEqual(["e1"]);
    expect(found.complete).toBe(true);
    const capped = l.searchRaw(undefined, { query: "tar.et", mode: "regex", offset: 0, limit: 5, scanLimit: 1 });
    expect(capped.rows).toHaveLength(0);
    expect(capped.scanned).toBe(1);
    expect(capped.complete).toBe(false);
  });
  it("backfills the full-text index of an existing populated ledger and stays verifiable", () => {
    const d = make(); const dbPath = path.join(d, "legacy.sqlite");
    const key = canonicalProjectIdentity({ liveCwd: d }).key;
    legacyLedger(dbPath, key, ["historic quasariform record", "unrelated line"]);
    const l = openLedger({ dbPath, project: { liveCwd: d } });
    expect(l.migrations.find(report => report.name === "raw-entries-fts")).toMatchObject({ applied: true, counts: { indexed: 2 } });
    expect((l.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    const page = l.searchRaw(undefined, { query: "quasariform", mode: "literal", offset: 0, limit: 5 });
    expect(page.rows.map(row => row.entryId)).toEqual(["legacy0"]);
    expect(page.complete).toBe(true);
    expect(l.backup(path.join(d, "backup.sqlite")).integrity).toBe("ok");
  });
  it("quarantines orphaned derived rows instead of dropping them silently", () => {
    const d = make(); const dbPath = path.join(d, "legacy.sqlite");
    const key = canonicalProjectIdentity({ liveCwd: d }).key;
    legacyLedger(dbPath, key, ["one"]);
    const seed = new (sqliteDriver())(dbPath);
    seed.exec("BEGIN IMMEDIATE");
    for (const node of ["kept-parent", "kept-child"]) seed.prepare("INSERT INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run(node, key, "{}", 1);
    seed.prepare("INSERT INTO summary_edges(parent_id,child_id) VALUES(?,?)").run("kept-parent", "kept-child");
    seed.prepare("INSERT INTO summary_edges(parent_id,child_id) VALUES(?,?)").run("ghost-parent", "kept-child");
    seed.prepare("INSERT INTO summary_node_revisions(node_id,revision,project_key,text,model_hash,created_at) VALUES(?,?,?,?,?,?)").run("ghost-node", 1, key, "lost", "h", 1);
    seed.exec("COMMIT");
    seed.close();
    const l = openLedger({ dbPath, project: { liveCwd: d } });
    expect(l.migrations.find(report => report.name === "derived-foreign-keys")?.counts).toEqual({ summary_edges: 1, summary_node_revisions: 1 });
    expect((l.db.prepare("SELECT count(*) n FROM summary_edges").get() as { n: number }).n).toBe(1);
    const quarantined = l.db.prepare("SELECT table_name,row_json FROM orphaned_rows ORDER BY table_name").all() as Array<{ table_name: string; row_json: string }>;
    expect(quarantined.map(row => row.table_name)).toEqual(["summary_edges", "summary_node_revisions"]);
    expect(JSON.parse(quarantined[0]!.row_json)).toMatchObject({ parent_id: "ghost-parent", child_id: "kept-child" });
    expect(JSON.parse(quarantined[1]!.row_json)).toMatchObject({ node_id: "ghost-node", text: "lost" });
    expect(() => l.db.prepare("INSERT INTO summary_edges(parent_id,child_id) VALUES(?,?)").run("kept-parent", "absent")).toThrow();
  });
  it("still deletes a project once foreign keys are enforced", () => {
    const d = make(); const l = openLedger({ dbPath: path.join(d, "a.sqlite"), project: { liveCwd: d } });
    l.appendRaw(entry(l.project.key, "keep", "e1"));
    l.transaction(db => {
      db.prepare("INSERT INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run("n1", l.project.key, "{}", 1);
      db.prepare("INSERT INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run("n2", l.project.key, "{}", 1);
      db.prepare("INSERT INTO summary_edges(parent_id,child_id) VALUES(?,?)").run("n2", "n1");
      db.prepare("INSERT INTO summary_node_revisions(node_id,revision,project_key,text,model_hash,created_at) VALUES(?,?,?,?,?,?)").run("n2", 1, l.project.key, "text", "h", 1);
    });
    const manifest = l.backup(path.join(d, "backup.sqlite"));
    l.deleteProject(createDeleteConfirmationToken(l.project.key), manifest);
    for (const table of ["raw_entries", "summary_edges", "summary_nodes", "summary_node_revisions", "raw_entries_fts", "projects"]) {
      expect((l.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });
  it("keeps searching without an fts5 module and marks the page incomplete", () => {
    const base = sqliteDriver() as unknown as { new (target: string, options?: unknown): { exec(sql: string): void } };
    setSqliteDriver(class extends base { exec(sql: string) { if (/using\s+fts5/i.test(sql)) throw new Error("no such module: fts5"); return super.exec(sql); } } as unknown as SqliteDriver);
    try {
      const d = make(); const l = openLedger({ dbPath: path.join(d, "a.sqlite"), project: { liveCwd: d } });
      expect(l.ftsAvailable).toBe(false);
      expect(l.migrations.find(report => report.name === "raw-entries-fts")).toMatchObject({ applied: false });
      l.appendRaw(entry(l.project.key, "durable haystack needle", "e1"));
      const page = l.searchRaw(undefined, { query: "NEEDLE", mode: "literal", offset: 0, limit: 5 });
      expect(page.rows.map(row => row.entryId)).toEqual(["e1"]);
      expect(page.complete).toBe(false);
      expect(l.searchRaw(undefined, { mode: "literal", offset: 0, limit: 5 }).complete).toBe(true);
    } finally { setSqliteDriver(undefined); }
  });
  it("keeps appending without fts5 and re-syncs the index on the next capable open", () => {
    const d = make(); const dbPath = path.join(d, "a.sqlite");
    const healthy = openLedger({ dbPath, project: { liveCwd: d } });
    expect(healthy.ftsAvailable).toBe(true);
    healthy.appendRaw(entry(healthy.project.key, "indexed while healthy", "e1"));
    healthy.close();
    const base = sqliteDriver() as unknown as { new (target: string, options?: unknown): { exec(sql: string): void } };
    setSqliteDriver(class extends base { exec(sql: string) { if (/using\s+fts5/i.test(sql)) throw new Error("no such module: fts5"); return super.exec(sql); } } as unknown as SqliteDriver);
    try {
      const blind = openLedger({ dbPath, project: { liveCwd: d } });
      expect(blind.ftsAvailable).toBe(false);
      blind.appendRaw(entry(blind.project.key, "appended while blind", "e2"));
      blind.close();
    } finally { setSqliteDriver(undefined); }
    const healed = openLedger({ dbPath, project: { liveCwd: d } });
    expect(healed.migrations.find(report => report.name === "raw-entries-fts")).toMatchObject({ applied: true, counts: { indexed: 2 } });
    const page = healed.searchRaw(undefined, { query: "blind", mode: "literal", offset: 0, limit: 5 });
    expect(page.rows.map(row => row.entryId)).toEqual(["e2"]);
    expect(page.complete).toBe(true);
  });
  it("reads entries sharing a timestamp back in insertion order", () => {
    const d = make(); const l = openLedger({ dbPath: path.join(d, "a.sqlite"), project: { liveCwd: d } });
    l.transaction(() => { for (const id of ["e1", "e2", "e3"]) l.appendRaw({ ...entry(l.project.key, `body ${id}`, id), createdAt: 5 }); });
    expect(l.readRaw(l.project.key, "s1").map(row => row.entryId)).toEqual(["e1", "e2", "e3"]);
    expect(l.readRawPage(l.project.key, "s1", 0, 3).map(row => row.entryId)).toEqual(["e1", "e2", "e3"]);
    expect(l.searchRaw(undefined, { sessionId: "s1", mode: "literal", offset: 0, limit: 3 }).rows.map(row => row.entryId)).toEqual(["e3", "e2", "e1"]);
  });
});
