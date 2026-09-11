import crypto from "node:crypto";
import { hashLcmPayload, type RawEntry } from "../storage/lcm-identity.js";
import type { LcmLedger } from "../storage/lcm-ledger.js";
import type { SqliteDatabase } from "../storage/sqlite.js";
import { utf8Bytes } from "./bounds.js";
import { buildLcmPrompt, emergencyReduce, type LcmModelResult, type LcmPromptMode, type LcmSummarizer } from "./lcm-model.js";

type LcmNodeState = "pending" | "ready" | "running" | "failed";
type LcmJobState = "pending" | "running" | "completed" | "failed";
export interface LcmSourceRef { sessionId: string; entryId: string; revision: number; payloadHash: string; }
type RawSourceRef = LcmSourceRef;
export interface LcmNode { nodeId: string; projectKey: string; sessionId: string; kind: "leaf" | "condensed"; sources: LcmSourceRef[]; children: string[]; depth: number; sourceHash: string; policyHash: string; modelHash: string; state: LcmNodeState; text?: string; createdAt: number; }
export interface LcmJob { jobId: string; projectKey: string; nodeId: string; priority: number; eligibleAt: number; state: LcmJobState; ownerId?: string; leaseToken?: string; leaseUntil?: number; attempts: number; nextRetryAt: number; error?: string; legacyRecovery?: true; createdAt: number; updatedAt: number; }
export interface LcmBudget { calls: number; inputTokens: number; outputTokens: number; cost: number; wallMs: number; }
export interface LcmBudgetPolicy extends LcmBudget { sessionCalls: number; }
const DEFAULT_LCM_BUDGET: LcmBudgetPolicy = { calls: Number.POSITIVE_INFINITY, inputTokens: Number.POSITIVE_INFINITY, outputTokens: Number.POSITIVE_INFINITY, cost: Number.POSITIVE_INFINITY, wallMs: Number.POSITIVE_INFINITY, sessionCalls: Number.POSITIVE_INFINITY };
export interface LcmMaintenanceOptions { now?: () => number; ownerId?: string; policyHash?: string; maxLeafEntries?: number; maxCondenseChildren?: number; maxInputChars?: number; maxOutputChars?: number; modelTimeoutMs?: number; budget?: Partial<LcmBudgetPolicy>; maxConcurrentJobs?: number | (() => number); }
export const DEFAULT_LEAF_ENTRIES = 32;
export const DEFAULT_MAINTENANCE_CONCURRENCY = 3;
export const LEASE_MS = 30_000;
export const LEASE_SWEEP_GRACE_MS = 60_000;
export type LcmRejectionReason = "job lease held" | "project lease held" | "job not eligible" | "budget exhausted" | "lease fenced";
export class LcmRejection extends Error {
  readonly reason: LcmRejectionReason;
  constructor(reason: LcmRejectionReason) { super(reason); this.name = "LcmRejection"; this.reason = reason; }
}
export const isLcmRejection = (error: unknown): error is LcmRejection => error instanceof LcmRejection;
export const isLcmCapacityRejection = (error: unknown): boolean => isLcmRejection(error) && (error.reason === "project lease held" || error.reason === "budget exhausted");
const LEGACY_CONTENTION_RETIREMENTS: ReadonlySet<string> = new Set(["job lease held", "project lease held", "LcmRejection: job lease held", "LcmRejection: project lease held"]);
const hash = (v: unknown) => hashLcmPayload(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v));
const rawHash = (e: RawEntry) => e.payloadHash;
const token = () => crypto.randomUUID();
const LCM_MODEL_LEVELS: ReadonlyArray<{ mode: LcmPromptMode; share: number }> = [{ mode: "detail", share: 1 }, { mode: "bullets", share: 0.5 }];
const CLAIMABLE_JOBS_SQL = `SELECT j.payload FROM maintenance_jobs j
JOIN summary_nodes n ON n.node_id=json_extract(j.payload,'$.nodeId') AND n.project_key=j.project_key
WHERE j.project_key=?
AND (j.status='pending' OR (j.status='running' AND CAST(coalesce(json_extract(j.payload,'$.leaseUntil'),0) AS INTEGER)<=?))
AND CAST(json_extract(j.payload,'$.eligibleAt') AS INTEGER)<=?
AND CAST(json_extract(j.payload,'$.nextRetryAt') AS INTEGER)<=?
AND (? IS NULL OR json_extract(n.payload,'$.sessionId')=?)
ORDER BY CAST(json_extract(j.payload,'$.priority') AS INTEGER) DESC, j.created_at, j.job_id
LIMIT ?`;
const LIVE_LEASES_SQL = `SELECT coalesce(json_extract(n.payload,'$.sessionId'),'') sessionId
FROM maintenance_jobs j
LEFT JOIN summary_nodes n ON n.node_id=json_extract(j.payload,'$.nodeId') AND n.project_key=j.project_key
WHERE j.project_key=? AND j.status='running' AND j.job_id<>? AND CAST(coalesce(json_extract(j.payload,'$.leaseUntil'),0) AS INTEGER)>?`;

export class LcmMaintenance {
  readonly projectKey: string;
  private readonly now: () => number;
  private readonly ownerId: string;
  private readonly policyHash: string;
  private readonly maxLeaf: number;
  private readonly maxChildren: number;
  private readonly maxInputChars: number;
  private readonly maxOutputChars: number;
  private readonly budget: LcmBudgetPolicy;
  private readonly modelTimeoutMs: number;
  private readonly maxConcurrentJobs: number | (() => number);
  constructor(private readonly ledger: LcmLedger, options: LcmMaintenanceOptions = {}) { this.maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAINTENANCE_CONCURRENCY; this.projectKey = ledger.project.key; this.now = options.now ?? Date.now; this.ownerId = options.ownerId ?? crypto.randomUUID(); this.policyHash = options.policyHash ?? hash("lcm-policy-v1"); this.maxLeaf = options.maxLeafEntries ?? DEFAULT_LEAF_ENTRIES; this.maxChildren = options.maxCondenseChildren ?? 4; this.maxInputChars = options.maxInputChars ?? 200_000; this.maxOutputChars = options.maxOutputChars ?? 4_096; this.modelTimeoutMs = options.modelTimeoutMs ?? 120_000; this.budget = { ...DEFAULT_LCM_BUDGET, ...options.budget }; }
  budgetPolicy(): LcmBudgetPolicy { return { ...this.budget }; }
  get concurrencyLimit(): number { const raw = typeof this.maxConcurrentJobs === "function" ? this.maxConcurrentJobs() : this.maxConcurrentJobs; return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : DEFAULT_MAINTENANCE_CONCURRENCY; }
  private liveLeases(db: SqliteDatabase, at: number, excludeJobId?: string): Array<{ sessionId: string }> { return db.prepare(LIVE_LEASES_SQL).all(this.projectKey, excludeJobId ?? "", at - LEASE_SWEEP_GRACE_MS) as Array<{ sessionId: string }>; }
  private admits(db: SqliteDatabase, at: number, sessionId: string, leases: ReadonlyArray<{ sessionId: string }>): boolean {
    const day = this.day(at);
    const project = this.usage(db, day);
    const session = this.usage(db, day, sessionId);
    let sessionReserved = 0;
    for (const lease of leases) if (lease.sessionId === sessionId) sessionReserved += 1;
    const reserved = leases.length + 1;
    const fits = (used: number, cap: number): boolean => used < cap && used + (project.calls > 0 ? (used / project.calls) * reserved : 0) <= cap;
    return project.calls + leases.length < this.budget.calls
      && fits(project.inputTokens, this.budget.inputTokens)
      && fits(project.outputTokens, this.budget.outputTokens)
      && fits(project.cost, this.budget.cost)
      && fits(project.wallMs, this.budget.wallMs)
      && session.calls + sessionReserved < this.budget.sessionCalls;
  }
  private recordRevision(db: SqliteDatabase, node: LcmNode): void {
    if (!node.text) return;
    const row = db.prepare("SELECT coalesce(max(revision),0) n FROM summary_node_revisions WHERE node_id=?").get(node.nodeId) as { n: number };
    db.prepare("INSERT OR IGNORE INTO summary_node_revisions(node_id,revision,project_key,text,model_hash,created_at) VALUES(?,?,?,?,?,?)")
      .run(node.nodeId, Number(row.n) + 1, this.projectKey, node.text, node.modelHash, this.now());
  }
  revisionsOf(nodeId: string): Array<{ revision: number; text: string; modelHash: string; createdAt: number }> {
    return this.ledger.readOnly(db => (db.prepare("SELECT revision, text, model_hash, created_at FROM summary_node_revisions WHERE node_id=? AND project_key=? ORDER BY revision").all(nodeId, this.projectKey) as Array<{ revision: number; text: string; model_hash: string; created_at: number }>)
      .map(row => ({ revision: Number(row.revision), text: row.text, modelHash: row.model_hash, createdAt: Number(row.created_at) })));
  }
  selectUpgrades(sessionId?: string, activeSources?: ReadonlySet<string>, limit = 1): LcmNode[] {
    return this.listNodes(100000)
      .filter(node => node.state === "ready" && node.modelHash === "emergency" && node.policyHash === this.policyHash
        && (!sessionId || node.sessionId === sessionId)
        && (!activeSources || node.sources.every(source => activeSources.has(this.sourceKey(source)))))
      .sort((left, right) => left.depth - right.depth || left.nodeId.localeCompare(right.nodeId))
      .slice(0, limit);
  }
  ancestorsOf(nodeId: string): string[] {
    return this.ledger.readOnly(db => {
      const seen = new Set<string>();
      const stack = [nodeId];
      const order: string[] = [];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const parents = db.prepare("SELECT e.parent_id FROM summary_edges e JOIN summary_nodes parent ON parent.node_id=e.parent_id WHERE e.child_id=? AND parent.project_key=?").all(current, this.projectKey) as Array<{ parent_id: string }>;
        for (const { parent_id: parent } of parents) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          order.push(parent);
          stack.push(parent);
        }
      }
      return order;
    });
  }
  reopen(nodeId: string, force = false): LcmJob {
    return this.ledger.transaction(db => {
      const row = db.prepare("SELECT payload FROM summary_nodes WHERE node_id=? AND project_key=?").get(nodeId, this.projectKey) as { payload?: string } | undefined;
      if (!row?.payload) throw new Error("node not found");
      const node = parse<LcmNode>(row.payload);
      if (node.projectKey !== this.projectKey) throw new Error("node project does not match ledger project");
      if (!force && node.modelHash !== "emergency") throw new Error("node already carries a model summary");
      const t = this.now();
      const job: LcmJob = { ...this.job(node), jobId: `job:upgrade:${token()}:${node.nodeId}`, createdAt: t, updatedAt: t };
      db.prepare("INSERT INTO maintenance_jobs(job_id,project_key,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run(job.jobId, this.projectKey, job.state, JSON.stringify(job), job.createdAt, job.updatedAt);
      return job;
    });
  }
  listNodes(limit = 100, offset = 0): LcmNode[] { return this.ledger.readOnly(db => (db.prepare("SELECT payload FROM summary_nodes WHERE project_key=? ORDER BY created_at,node_id LIMIT ? OFFSET ?").all(this.projectKey, limit, offset) as Array<{payload:string}>).map(r => { const node = parse<LcmNode>(r.payload); if (node.projectKey !== this.projectKey) throw new Error("node project does not match ledger project"); return node; })); }
  getNode(nodeId: string): LcmNode | undefined { return this.ledger.readOnly(db => { const row = db.prepare("SELECT payload FROM summary_nodes WHERE node_id=? AND project_key=?").get(nodeId, this.projectKey) as {payload?:string}|undefined; if (!row?.payload) return undefined; const node = parse<LcmNode>(row.payload); if (node.projectKey !== this.projectKey) throw new Error("node project does not match ledger project"); return node; }); }
  /** Drops a node a parent already condensed, and one whose sources another selected node fully contains. */
  getFrontier(sessionId?: string, activeSources?: ReadonlySet<string>): LcmNode[] { const nodes=this.listNodes(100000).filter(n => n.state === "ready" && n.policyHash === this.policyHash && (!sessionId || n.sessionId === sessionId) && (!activeSources || n.sources.every(s => activeSources.has(this.sourceKey(s))))); const condensed=new Set(nodes.flatMap(n=>n.children)); const standing=nodes.filter(n=>!condensed.has(n.nodeId)); const ranked=[...standing].sort((a,b)=>b.sources.length-a.sources.length||a.nodeId.localeCompare(b.nodeId)); const kept: LcmNode[]=[]; const shadowed=new Set<string>(); for (const node of ranked) { const keys=node.sources.map(s=>this.sourceKey(s)); if (kept.some(other=>{ const held=new Set(other.sources.map(s=>this.sourceKey(s))); return keys.every(key=>held.has(key)); })) { shadowed.add(node.nodeId); continue; } kept.push(node); } return standing.filter(n=>!shadowed.has(n.nodeId)); }
  recentJobs(limit = 200): LcmJob[] { return this.ledger.readOnly(db => (db.prepare("SELECT payload FROM maintenance_jobs WHERE project_key=? ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?").all(this.projectKey, limit) as Array<{payload:string}>).map(r => { const job = parse<LcmJob>(r.payload); if (job.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); return job; })); }
  listJobs(limit = 100): LcmJob[] { return this.ledger.readOnly(db => (db.prepare("SELECT payload FROM maintenance_jobs WHERE project_key=? ORDER BY created_at,job_id LIMIT ?").all(this.projectKey, limit) as Array<{payload:string}>).map(r => { const job = parse<LcmJob>(r.payload); if (job.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); return job; })); }
  jobForNode(nodeId: string): LcmJob | undefined { return this.ledger.readOnly(db => { const row = db.prepare("SELECT payload FROM maintenance_jobs WHERE job_id=? AND project_key=?").get(`job:${nodeId}`, this.projectKey) as {payload?:string}|undefined; if (!row?.payload) return undefined; const job = parse<LcmJob>(row.payload); if (job.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); return job; }); }
  claimableJobs(sessionId?: string, limit = 64): LcmJob[] { const t = this.now(); const scope = sessionId ?? null; return this.ledger.readOnly(db => (db.prepare(CLAIMABLE_JOBS_SQL).all(this.projectKey, t - LEASE_SWEEP_GRACE_MS, t, t, scope, scope, limit) as Array<{payload:string}>).map(r => { const job = parse<LcmJob>(r.payload); if (job.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); return job; })); }
  countJobs(state: LcmJobState, updatedSince = 0): number { return this.ledger.readOnly(db => Number((db.prepare("SELECT count(*) n FROM maintenance_jobs WHERE project_key=? AND status=? AND updated_at>=?").get(this.projectKey, state, updatedSince) as {n:number}).n)); }
  isClaimable(job: LcmJob): boolean { const t = this.now(); return (job.state === "pending" || (job.state === "running" && (job.leaseUntil ?? 0) + LEASE_SWEEP_GRACE_MS <= t)) && job.eligibleAt <= t && job.nextRetryAt <= t; }
  sweepExpiredLeases(): LcmJob[] { return this.ledger.transaction(db => { const t = this.now() - LEASE_SWEEP_GRACE_MS; const rows = db.prepare("SELECT payload FROM maintenance_jobs WHERE project_key=? AND status=?").all(this.projectKey, "running") as Array<{payload:string}>; const swept: LcmJob[] = []; for (const row of rows) { const old = parse<LcmJob>(row.payload); if (old.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); if ((old.leaseUntil ?? 0) > t) continue; const now = this.now(); const { ownerId: _ownerId, leaseToken: _leaseToken, leaseUntil: _leaseUntil, ...base } = old; const job: LcmJob = { ...base, state: "pending", error: "lease expired", eligibleAt: now, nextRetryAt: now, updatedAt: now }; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(job.state, JSON.stringify(job), job.updatedAt, job.jobId, this.projectKey); swept.push(job); } return swept; }); }
  expiredLeases(): number { const t = this.now() - LEASE_SWEEP_GRACE_MS; return this.ledger.readOnly(db => Number((db.prepare("SELECT count(*) n FROM maintenance_jobs WHERE project_key=? AND status=? AND coalesce(json_extract(payload,'$.leaseUntil'),0)<=?").get(this.projectKey, "running", t) as {n:number}).n)); }
  retryFailedJobs(): LcmJob[] { return this.ledger.transaction(db => { const rows = db.prepare("SELECT payload FROM maintenance_jobs WHERE project_key=? AND status=?").all(this.projectKey, "failed") as Array<{payload:string}>; const retried: LcmJob[] = []; for (const row of rows) { const old = parse<LcmJob>(row.payload); if (old.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); const t = this.now(); const { error: _error, ownerId: _ownerId, leaseToken: _leaseToken, leaseUntil: _leaseUntil, ...base } = old; const job: LcmJob = { ...base, state: "pending", attempts: 0, eligibleAt: t, nextRetryAt: t, updatedAt: t }; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(job.state, JSON.stringify(job), job.updatedAt, job.jobId, this.projectKey); retried.push(job); } return retried; }); }
  recoverLegacyContentionRetirements(): LcmJob[] { return this.ledger.transaction(db => { const rows = db.prepare("SELECT payload FROM maintenance_jobs WHERE project_key=? AND status=?").all(this.projectKey, "failed") as Array<{payload:string}>; const recovered: LcmJob[] = []; for (const row of rows) { const old = parse<LcmJob>(row.payload); if (old.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); if (old.legacyRecovery || !LEGACY_CONTENTION_RETIREMENTS.has(old.error ?? "")) continue; const t = this.now(); const { error: _error, ...base } = old; const job: LcmJob = { ...base, state: "pending", attempts: 0, legacyRecovery: true, eligibleAt: t, nextRetryAt: t, updatedAt: t }; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(job.state, JSON.stringify(job), job.updatedAt, job.jobId, this.projectKey); recovered.push(job); } return recovered; }); }
  recordFailure(job: LcmJob, error: unknown): LcmJob | undefined { return this.ledger.transaction(db => { const row = db.prepare("SELECT payload FROM maintenance_jobs WHERE job_id=? AND project_key=?").get(job.jobId, this.projectKey) as {payload?:string}|undefined; if (!row?.payload) return undefined; const old = parse<LcmJob>(row.payload); if (old.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); const t = this.now(); if (old.state === "completed" || old.attempts !== job.attempts) return old; if (old.state === "running" && (old.leaseUntil ?? 0) > t && old.leaseToken !== job.leaseToken) return old; const attempts = old.attempts + 1; const delay = Math.min(900_000, 30_000 * 2 ** (attempts - 1)); const { ownerId: _ownerId, leaseToken: _leaseToken, leaseUntil: _leaseUntil, ...base } = old; const next: LcmJob = { ...base, attempts, error: String(error), state: attempts >= 3 ? "failed" : "pending", eligibleAt: t + delay, nextRetryAt: t + delay, updatedAt: t }; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(next.state, JSON.stringify(next), next.updatedAt, next.jobId, this.projectKey); return next; }); }
  selectLeaf(entries = this.ledger.readRaw(this.projectKey), activeSources?: ReadonlySet<string>): RawEntry[] { const first = entries[0]; if (!first) return []; const nodes = this.listNodes(100000).filter(n => n.state !== "failed" && n.policyHash === this.policyHash && n.sessionId === first.sessionId && (!activeSources || n.sources.every(s => activeSources.has(this.sourceKey(s))))); const covered = new Set(nodes.flatMap(n => n.sources.map(s => this.sourceKey(s)))); const candidates = entries.filter(e => e.sessionId === first.sessionId && !covered.has(this.sourceKey(e))); const picked: RawEntry[] = []; let chars = 0; for (const entry of candidates) { if (picked.length >= this.maxLeaf) break; const size = entry.payloadJson.length; if (picked.length > 0 && chars + size > this.maxInputChars) break; picked.push(entry); chars += size; } return picked; }
  selectCondensation(sessionId?: string, activeSources?: ReadonlySet<string>): LcmNode[] { const nodes = this.listNodes(100000).filter(n => n.state === "ready" && n.policyHash === this.policyHash && (!sessionId || n.sessionId === sessionId) && (!activeSources || n.sources.every(s => activeSources.has(this.sourceKey(s))))); const eligible = new Set(nodes.map(n => n.nodeId)); const edges = this.ledger.readOnly(db => db.prepare("SELECT e.parent_id,e.child_id FROM summary_edges e JOIN summary_nodes parent ON parent.node_id=e.parent_id AND parent.project_key=? JOIN summary_nodes child ON child.node_id=e.child_id AND child.project_key=parent.project_key WHERE parent.project_key=?").all(this.projectKey, this.projectKey) as Array<{parent_id:string;child_id:string}>); const consumed = new Set(edges.filter(e => eligible.has(e.parent_id)).map(e => e.child_id)); const candidates = nodes.filter(n => !consumed.has(n.nodeId)); const first = candidates[0]; if (!first) return []; const depth = Math.min(...candidates.map(n => n.depth)); const sameDepth = candidates.filter(n => n.depth === depth); if (depth > 0 && sameDepth.length < 2) return []; return candidates.filter(n => n.projectKey === first.projectKey && n.sessionId === first.sessionId && n.depth === depth).sort((a,b) => a.nodeId.localeCompare(b.nodeId)).slice(0, this.maxChildren); }
  createLeaf(entries: RawEntry[]): LcmNode | undefined { if (!entries.length) return undefined; const source = entries.map((e, index) => { if (e.projectKey !== this.projectKey) throw new Error("entry project does not match ledger project"); const payload = parse<{type?: unknown; id?: unknown}>(e.payloadJson); if (typeof payload.type !== "string" || !payload.type || payload.id !== e.entryId) throw new Error("invalid raw payload"); if (hash(payload) !== rawHash(e)) throw new Error("payload hash mismatch"); return { sessionId:e.sessionId, entryId:e.entryId, revision:e.revision, payloadHash:rawHash(e) }; }); this.validateSources(source); const node: LcmNode = { nodeId:`leaf:${hash({ projectKey:this.projectKey, source, policyHash:this.policyHash })}`, projectKey:this.projectKey, sessionId:entries[0]!.sessionId, kind:"leaf", sources:source, children:[], depth:0, sourceHash:hash(source.map(s=>s.payloadHash)), policyHash:this.policyHash, modelHash:"", state:"pending", createdAt:this.now() }; this.publish(node); return node; }
  createCondensed(children: LcmNode[]): LcmNode | undefined { if (!children.length) return undefined; if (children.some(c => c.state !== "ready")) throw new Error("condensation requires ready children"); if (new Set(children.map(c=>c.sessionId)).size !== 1 || new Set(children.map(c=>c.depth)).size !== 1) throw new Error("mixed session or depth"); const storedChildren = children.map((child) => this.getNode(child.nodeId)); if (storedChildren.some((child) => !child || child.projectKey !== this.projectKey)) throw new Error("child project does not match ledger project"); if (storedChildren.some((child, index) => JSON.stringify(child) !== JSON.stringify(children[index]))) throw new Error("child payload changed"); const source = [...new Map(storedChildren.flatMap(c => c!.sources).map((value) => [this.sourceKey(value), value])).values()]; this.validateSources(source); const node: LcmNode = { nodeId:`condensed:${hash({ projectKey:this.projectKey, children:storedChildren.map(c=>c!.nodeId), policyHash:this.policyHash })}`, projectKey:this.projectKey, sessionId:children[0]!.sessionId, kind:"condensed", sources:source, children:children.map(c=>c.nodeId), depth:Math.max(...children.map(c=>c.depth))+1, sourceHash:hash(children.map(c=>c.sourceHash)), policyHash:this.policyHash, modelHash:"", state:"pending", createdAt:this.now() }; this.publish(node); return node; }
  private validateSources(source: LcmSourceRef[]) { const seen = new Set<string>(); for (const s of source) { if (seen.has(this.sourceKey(s))) throw new Error("duplicate source identity"); seen.add(this.sourceKey(s)); } if (new Set(source.map(s => s.sessionId)).size !== 1) throw new Error("cross-session ranges"); }
  private sourceKey(source: Pick<LcmSourceRef, "sessionId" | "entryId" | "revision">) { return `${source.sessionId}:${source.entryId}:${source.revision}`; }
  private publish(node: LcmNode) { this.ledger.transaction(db => { if (node.children.includes(node.nodeId)) throw new Error("cycle"); for (const child of node.children) if (!db.prepare("SELECT 1 FROM summary_nodes WHERE node_id=? AND project_key=?").get(child,this.projectKey)) throw new Error("missing child"); db.prepare("INSERT OR IGNORE INTO summary_nodes(node_id,project_key,payload,created_at) VALUES(?,?,?,?)").run(node.nodeId,this.projectKey,JSON.stringify(node),node.createdAt); for (const child of node.children) db.prepare("INSERT OR IGNORE INTO summary_edges(parent_id,child_id) VALUES(?,?)").run(node.nodeId,child); const job = this.job(node); db.prepare("INSERT OR IGNORE INTO maintenance_jobs(job_id,project_key,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(job.jobId,this.projectKey,job.state,JSON.stringify(job),job.createdAt,job.updatedAt); }); }
  private job(node:LcmNode): LcmJob { const t=this.now(); return {jobId:`job:${node.nodeId}`,projectKey:this.projectKey,nodeId:node.nodeId,priority:node.kind === "condensed" ? 20 : 10,eligibleAt:t,state:"pending",attempts:0,nextRetryAt:t,createdAt:t,updatedAt:t}; }
  claim(jobId: string, ownerId = this.ownerId): LcmJob { return this.ledger.transaction(db => { const row = db.prepare("SELECT payload FROM maintenance_jobs WHERE job_id=? AND project_key=?").get(jobId,this.projectKey) as {payload?:string}|undefined; if (!row?.payload) throw new Error("job not found"); const old=parse<LcmJob>(row.payload); if (old.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); const t=this.now(); const expired = old.state === "running" && (old.leaseUntil ?? 0) + LEASE_SWEEP_GRACE_MS <= t; if (old.state === "running" && !expired) throw new LcmRejection("job lease held"); if ((old.state !== "pending" && !expired) || old.eligibleAt > t || old.nextRetryAt > t) throw new LcmRejection("job not eligible"); const leases = this.liveLeases(db, t, old.jobId); if (leases.length >= this.concurrencyLimit) throw new LcmRejection("project lease held"); const nodeRow = db.prepare("SELECT payload FROM summary_nodes WHERE node_id=? AND project_key=?").get(old.nodeId,this.projectKey) as {payload?:string}|undefined; const sessionId = nodeRow?.payload ? parse<LcmNode>(nodeRow.payload).sessionId : ""; if (!this.admits(db, t, sessionId, leases)) throw new LcmRejection("budget exhausted"); const out={...old,state:"running" as const,ownerId,leaseToken:token(),leaseUntil:t+LEASE_MS,updatedAt:t}; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(out.state,JSON.stringify(out),t,jobId,this.projectKey); return out; }); }
  claimEmergency(jobId: string, ownerId = this.ownerId): LcmJob { return this.ledger.transaction(db => { const row = db.prepare("SELECT payload FROM maintenance_jobs WHERE job_id=? AND project_key=?").get(jobId,this.projectKey) as {payload?:string}|undefined; if (!row?.payload) throw new Error("job not found"); const old = parse<LcmJob>(row.payload); if (old.projectKey !== this.projectKey) throw new Error("job project does not match ledger project"); const t = this.now(); const expired = old.state === "running" && (old.leaseUntil ?? 0) <= t; if (old.state === "running" && !expired) throw new LcmRejection("job lease held"); if (old.state === "completed") throw new Error("job already completed"); const out = { ...old, state: "running" as const, ownerId, leaseToken: token(), leaseUntil: t + LEASE_MS, updatedAt: t }; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(out.state,JSON.stringify(out),t,jobId,this.projectKey); return out; }); }
  renew(job:LcmJob): LcmJob { return this.fenced(job, old => ({...old,leaseUntil:this.now()+LEASE_MS,updatedAt:this.now()})); }
  private validateText(text: unknown): asserts text is string { if (typeof text !== "string" || text.length === 0) throw new Error("invalid summary text"); let length = 0; for (const _ of text) { length += 1; if (length > this.maxOutputChars) throw new Error("summary exceeds output bound"); } }
  private validateShrink(text: string, inputBytes: number): void { if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) throw new Error("invalid input bound"); if (utf8Bytes(text) >= inputBytes) throw new Error("summary does not shrink its input"); }
  withinBudget(sessionId: string, excludeJobId?: string): boolean { return this.ledger.readOnly(db => { const at = this.now(); return this.admits(db, at, sessionId, this.liveLeases(db, at, excludeJobId)); }); }
  private accountRejected(sessionId: string, result: LcmModelResult): void { if (![result.inputTokens,result.outputTokens,result.cost,result.wallMs].every((value) => Number.isFinite(value) && value >= 0)) return; try { this.ledger.transaction(db => this.account(db, sessionId, result)); } catch {} }
  complete(job:LcmJob, result:LcmModelResult, inputBytes: number): LcmNode { this.validateText(result.text); this.validateShrink(result.text, inputBytes); return this.ledger.transaction(db => { const current=this.readJob(db,job.jobId); this.assertLease(current,job); if (current.nodeId !== job.nodeId) throw new Error("job node mismatch"); const row=db.prepare("SELECT payload FROM summary_nodes WHERE node_id=? AND project_key=?").get(job.nodeId,this.projectKey) as {payload?:string}|undefined; if (!row?.payload) throw new Error("node not found"); const node=parse<LcmNode>(row.payload); if (node.projectKey !== this.projectKey || node.nodeId !== current.nodeId) throw new Error("node project does not match ledger project"); for (const source of node.sources) { const raw=db.prepare("SELECT payload_json,session_id FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND revision=?").get(this.projectKey,source.sessionId,source.entryId,source.revision) as {payload_json?:string;session_id?:string}|undefined; if (!raw?.payload_json || hash(parse(raw.payload_json)) !== source.payloadHash || raw.session_id !== source.sessionId) throw new Error("stale source"); } if (![result.inputTokens,result.outputTokens,result.cost,result.wallMs].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("invalid model usage"); const projectUsage = this.usage(db, this.day(this.now())); const sessionUsage = this.usage(db, this.day(this.now()), node.sessionId); if (projectUsage.calls + 1 > this.budget.calls || projectUsage.inputTokens + result.inputTokens > this.budget.inputTokens || projectUsage.outputTokens + result.outputTokens > this.budget.outputTokens || projectUsage.cost + result.cost > this.budget.cost || projectUsage.wallMs + result.wallMs > this.budget.wallMs || sessionUsage.calls + 1 > this.budget.sessionCalls) throw new Error("budget exhausted"); this.recordRevision(db, node); const out={...node,state:"ready" as const,text:result.text,modelHash:result.modelHash}; this.account(db,node.sessionId,result); db.prepare("UPDATE summary_nodes SET payload=? WHERE node_id=? AND project_key=?").run(JSON.stringify(out),node.nodeId,this.projectKey); const { ownerId: _ownerId, leaseToken: _leaseToken, leaseUntil: _leaseUntil, ...base } = current; const done={...base,state:"completed" as const,updatedAt:this.now()}; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(done.state,JSON.stringify(done),done.updatedAt,done.jobId,this.projectKey); return out; }); }
  completeEmergency(job:LcmJob, text:string): LcmNode { this.validateText(text); return this.ledger.transaction(db => { const current=this.readJob(db,job.jobId); this.assertLease(current,job); if (current.nodeId !== job.nodeId) throw new Error("job node mismatch"); const row=db.prepare("SELECT payload FROM summary_nodes WHERE node_id=? AND project_key=?").get(job.nodeId,this.projectKey) as {payload?:string}|undefined; if (!row?.payload) throw new Error("node not found"); const node=parse<LcmNode>(row.payload); if (node.projectKey !== this.projectKey || node.nodeId !== current.nodeId) throw new Error("node project does not match ledger project"); for (const source of node.sources) { const raw=db.prepare("SELECT payload_json,session_id FROM raw_entries WHERE project_key=? AND session_id=? AND entry_id=? AND revision=?").get(this.projectKey,source.sessionId,source.entryId,source.revision) as {payload_json?:string;session_id?:string}|undefined; if (!raw?.payload_json || hash(parse(raw.payload_json)) !== source.payloadHash || raw.session_id !== source.sessionId) throw new Error("stale source"); } this.recordRevision(db, node); const out={...node,state:"ready" as const,text,modelHash:"emergency"}; db.prepare("UPDATE summary_nodes SET payload=? WHERE node_id=? AND project_key=?").run(JSON.stringify(out),node.nodeId,this.projectKey); const { ownerId: _ownerId, leaseToken: _leaseToken, leaseUntil: _leaseUntil, ...base } = current; const done={...base,state:"completed" as const,updatedAt:this.now()}; db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(done.state,JSON.stringify(done),done.updatedAt,done.jobId,this.projectKey); return out; }); }
  fail(job:LcmJob,error:string): LcmJob { return this.fenced(job, old => { const attempts=old.attempts+1; const delay=Math.min(900_000,30_000*2**(attempts-1)); const { ownerId: _ownerId, leaseToken: _leaseToken, leaseUntil: _leaseUntil, ...base } = old; return {...base,attempts,error,state:attempts>=3?"failed":"pending",eligibleAt:this.now()+delay,nextRetryAt:this.now()+delay,updatedAt:this.now()}; }); }
  async run(job:LcmJob, model:LcmSummarizer, input:string, signal=new AbortController().signal): Promise<LcmNode> {
    let sources: LcmSourceRef[] = [];
    let claimed: LcmJob | undefined;
    const controller = new AbortController();
    let renew: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => controller.abort(), this.modelTimeoutMs);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const inputBytes = utf8Bytes(input);
    try {
      claimed = this.claim(job.jobId, job.ownerId ?? this.ownerId);
      const node = this.getNode(claimed.nodeId);
      sources = node?.sources ?? [];
      const kind = node?.kind ?? "leaf";
      const sessionId = node?.sessionId ?? "";
      renew = setInterval(() => { try { if (claimed) claimed = this.renew(claimed); } catch {} }, 10_000);
      let lastError: unknown = new Error("LCM summarization did not converge");
      for (const [index, level] of LCM_MODEL_LEVELS.entries()) {
        if (controller.signal.aborted) break;
        if (index > 0 && !this.withinBudget(sessionId, job.jobId)) break;
        const target = Math.max(1, Math.min(Math.floor(this.maxOutputChars * level.share), inputBytes - 1));
        let result: LcmModelResult;
        try {
          result = await Promise.race([
            model.generate({ prompt: buildLcmPrompt(kind, input, this.maxInputChars, level.mode, target), sessionId, signal: controller.signal }),
            new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("LCM timeout")), { once: true })),
          ]);
        } catch (error) { lastError = error; continue; }
        if (utf8Bytes(result.text) >= inputBytes) { this.accountRejected(sessionId, result); lastError = new Error("summary does not shrink its input"); continue; }
        return this.complete(claimed, result, inputBytes);
      }
      throw lastError;
    } catch (error) {
      if (!claimed) throw error;
      const fallback = emergencyReduce(input, this.maxOutputChars, sources);
      try { return this.completeEmergency(claimed, fallback); }
      catch (fenced) {
        if (isLcmRejection(fenced) && fenced.reason === "lease fenced") throw fenced;
        try { this.fail(claimed, String(error)); } catch {}
        throw error;
      }
    } finally { clearTimeout(timer); if (renew) clearInterval(renew); signal.removeEventListener("abort", abort); }
  }
  private day(ms:number): string { return new Date(ms).toISOString().slice(0,10); }
  private usage(db:any, day:string, sessionId?:string): LcmBudget { const q = sessionId === undefined ? "SELECT COALESCE(SUM(calls),0) calls,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(cost),0) cost,COALESCE(SUM(wall_ms),0) wallMs FROM maintenance_usage WHERE project_key=? AND day=?" : "SELECT COALESCE(SUM(calls),0) calls,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(cost),0) cost,COALESCE(SUM(wall_ms),0) wallMs FROM maintenance_usage WHERE project_key=? AND day=? AND session_id=?"; const r=(sessionId === undefined ? db.prepare(q).get(this.projectKey,day) : db.prepare(q).get(this.projectKey,day,sessionId)) as LcmBudget; return r; }
  private account(db:any, sessionId:string, result:LcmModelResult) { const d=this.day(this.now()); db.prepare("INSERT INTO maintenance_usage(project_key,day,session_id,calls,input_tokens,output_tokens,cost,wall_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_key,day,session_id) DO UPDATE SET calls=calls+excluded.calls,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,cost=cost+excluded.cost,wall_ms=wall_ms+excluded.wall_ms").run(this.projectKey,d,sessionId,1,result.inputTokens,result.outputTokens,result.cost,result.wallMs); }
  private readJob(db: any,id:string):LcmJob { const row=db.prepare("SELECT payload FROM maintenance_jobs WHERE job_id=? AND project_key=?").get(id,this.projectKey) as {payload:string}|undefined; if(!row) throw new Error("job not found"); const job=parse<LcmJob>(row.payload); if(job.projectKey!==this.projectKey) throw new Error("job project does not match ledger project"); return job; }
  private assertLease(current:LcmJob, expected:LcmJob) { if(current.ownerId!==expected.ownerId || current.leaseToken!==expected.leaseToken || current.state!=="running" || (current.leaseUntil??0)<this.now()) throw new LcmRejection("lease fenced"); }
  private fenced(job:LcmJob, update:(old:LcmJob)=>LcmJob):LcmJob { return this.ledger.transaction(db => { const old=this.readJob(db,job.jobId); this.assertLease(old,job); const out=update(old); db.prepare("UPDATE maintenance_jobs SET status=?,payload=?,updated_at=? WHERE job_id=? AND project_key=?").run(out.state,JSON.stringify(out),out.updatedAt,out.jobId,this.projectKey); return out; }); }
}
