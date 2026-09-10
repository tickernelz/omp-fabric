import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { canonicalLcmPayload, canonicalProjectIdentity, hashLcmPayload, LcmLedger, type RawEntry } from "../storage/lcm-ledger.js";
import { migrationDropReasons, reconcileSession, type MigrationDrops } from "../storage/lcm-migration.js";
import { clipUtf8, MAX_SUMMARY_BYTES, utf8Bytes } from "./bounds.js";
import { lcmSummaryAddress, renderLcmChildAddresses, renderLcmSourceAddresses } from "./lcm-addresses.js";
import { emergencyReduce, LcmModelAdapter, type LcmSummarizer } from "./lcm-model.js";
import { LCM_RECOVERY_POINTER } from "./render.js";
import { reconcileLcmState } from "./lcm-status.js";
import { DEFAULT_LEAF_ENTRIES, LcmMaintenance, type LcmBudgetPolicy, type LcmJob, type LcmNode } from "./lcm-maintenance.js";
import type { LcmCompactionInput, LcmCompactionOutput } from "./hook.js";

type LcmMaintenanceTrigger = "occupancy" | "jobs" | "backlog";

export interface LcmPreview {
  text: string;
  nodes: number;
  summaryBytes: number;
  sourceBytes: number;
  coveredSources: number;
  activeSources: number;
}

export interface LcmReconciliation {
  degraded: boolean;
  errors: number;
  raced: number;
  drops: MigrationDrops;
  reasons: string[];
}

export interface LcmReport {
  projectKey: string;
  sessionId: string | undefined;
  state: string;
  ledgerState: string;
  degraded: string | undefined;
  summaryModel: string | undefined;
  rawEntries: number;
  sessionEntries: number;
  modelNodes: number;
  emergencyNodes: number;
  pendingNodes: number;
  pendingJobs: number;
  upgradableNodes: number;
  usage: { calls: number; inputTokens: number; outputTokens: number; cost: number; wallMs: number };
  budget: { calls: number; sessionCalls: number; wallMs: number };
  reconciliation: LcmReconciliation | undefined;
}

export interface LcmRuntimeOptions {
  rootDir?: string;
  summaryModel?: string;
  maxLeafEntries?: number;
  maxCondenseChildren?: number;
  lcmMaxInputChars?: number;
  lcmMaxOutputTokens?: number;
  lcmMaxOutputChars?: number;
  maxMaintenancePasses?: number;
  modelSummaries?: boolean;
  modelTimeoutSeconds?: number;
  maxDailyModelCalls?: number;
  maxSessionModelCalls?: number;
  maxDailyModelSeconds?: number;
  maintenanceRunSeconds?: number;
  softThresholdRatio?: number;
}

const LEASE_SWEEP_GRACE_MS = 60_000;
const MAX_RECONCILE_RECOVERIES = 3;
const CLAIMABLE_JOB_LIMIT = 256;
const FAILED_JOB_WINDOW_MS = 24 * 60 * 60 * 1_000;
const NODE_ADDRESS_LABEL = "address: ";
const BLOCK_SEPARATOR = "\n\n";
const WITHHELD_EXPAND_LABEL = "; expand: ";

const withheldHeadline = (count: number): string =>
  `… withheld ${count} frontier node${count === 1 ? "" : "s"} that did not fit`;

const withheldNotice = (nodeIds: readonly string[], budget: number): string => {
  const headline = withheldHeadline(nodeIds.length);
  const addresses = nodeIds.map(lcmSummaryAddress);
  const line = (kept: readonly string[], omitted: number): string =>
    `${headline}${WITHHELD_EXPAND_LABEL}${kept.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}`;
  const kept: string[] = [];
  for (const address of addresses) {
    if (utf8Bytes(line([...kept, address], addresses.length - kept.length - 1)) > budget) break;
    kept.push(address);
  }
  return kept.length === 0 ? headline : line(kept, addresses.length - kept.length);
};

const clipOversized = (
  blocks: ReadonlyArray<{ node: LcmNode; head: string }>,
  headBytes: readonly number[],
  footer: string,
  separator: number,
): string => {
  let widest = 0;
  for (let index = 1; index < blocks.length; index += 1) if (headBytes[index]! > headBytes[widest]!) widest = index;
  const { node } = blocks[widest]!;
  const addressLine = `\n${NODE_ADDRESS_LABEL}${lcmSummaryAddress(node.nodeId)}`;
  const withheld = blocks.filter((_, index) => index !== widest).map((block) => block.node.nodeId);
  const available = MAX_SUMMARY_BYTES - utf8Bytes(footer) - utf8Bytes(addressLine);
  const notice = withheld.length === 0
    ? ""
    : withheldNotice(withheld, Math.max(utf8Bytes(withheldHeadline(withheld.length)), Math.floor(available / 2)));
  const text = clipUtf8(node.text ?? "", available - (notice ? separator + utf8Bytes(notice) : 0));
  const head = text ? `${text}${addressLine}` : addressLine.slice(1);
  return `${[head, ...(notice ? [notice] : [])].join(BLOCK_SEPARATOR)}${footer}`;
};

export const renderAddressedFrontier = (frontier: readonly LcmNode[]): string => {
  const blocks = frontier
    .filter((node) => Boolean(node.text))
    .map((node) => ({ node, head: `${node.text ?? ""}\n${NODE_ADDRESS_LABEL}${lcmSummaryAddress(node.nodeId)}` }));
  if (blocks.length === 0) return "";
  const footer = `\n\n${LCM_RECOVERY_POINTER}`;
  const separator = utf8Bytes(BLOCK_SEPARATOR);
  const footerBytes = utf8Bytes(footer);
  const headBytes = blocks.map((block) => utf8Bytes(block.head));
  const floorFor = (kept: number): number =>
    kept === blocks.length ? 0 : separator + utf8Bytes(withheldHeadline(blocks.length - kept));

  const kept: number[] = [];
  const withheld: number[] = [];
  let body = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const grown = body + headBytes[index]! + (kept.length > 0 ? separator : 0);
    if (grown + footerBytes + floorFor(kept.length + 1) > MAX_SUMMARY_BYTES) { withheld.push(index); continue; }
    kept.push(index);
    body = grown;
  }
  if (kept.length === 0) return clipOversized(blocks, headBytes, footer, separator);

  const room = MAX_SUMMARY_BYTES - body - footerBytes - (withheld.length === 0 ? 0 : separator);
  const notice = withheld.length === 0
    ? ""
    : withheldNotice(withheld.map((index) => blocks[index]!.node.nodeId), Math.max(utf8Bytes(withheldHeadline(withheld.length)), Math.floor(room / 2)));
  const perNode = Math.max(0, Math.floor((room - utf8Bytes(notice)) / kept.length) - 1);
  const rendered = kept.map((index) => {
    const { node, head } = blocks[index]!;
    const addresses = node.sources.length > 0
      ? renderLcmSourceAddresses(node.sources, perNode)
      : renderLcmChildAddresses(node.children, perNode);
    return addresses && utf8Bytes(addresses) <= perNode ? `${head}\n${addresses}` : head;
  });
  return `${[...rendered, ...(notice ? [notice] : [])].join(BLOCK_SEPARATOR)}${footer}`;
};

export class LcmRuntime {
  readonly ledger: LcmLedger;
  readonly maintenance: LcmMaintenance;
  private readonly context: ExtensionContext;
  private readonly resolveOptions: () => LcmRuntimeOptions;
  private readonly abort = new AbortController();
  private writePending: Promise<void> = Promise.resolve();
  private maintenancePending: Promise<void> = Promise.resolve();
  private closed = false;
  private dirty = false;
  private degradedError: unknown;
  private activeSources = new Set<string>();
  private activeSessionId: string | undefined;
  private lastReconciliation: LcmReconciliation | undefined;
  private reconcileRecoveries = 0;

  constructor(context: ExtensionContext, options: LcmRuntimeOptions | (() => LcmRuntimeOptions) = {}) {
    this.context = context;
    this.resolveOptions = typeof options === "function" ? options : () => options;
    const initial = this.resolveOptions();
    const recorded = context.sessionManager.getRecordedCwd?.();
    const liveCwd = recorded || context.cwd;
    const project = canonicalProjectIdentity({ liveCwd });
    const ledgerOptions = initial.rootDir === undefined
      ? { project: { liveCwd: project.canonicalPath ?? liveCwd } }
      : { rootDir: initial.rootDir, project: { liveCwd: project.canonicalPath ?? liveCwd } };
    this.ledger = new LcmLedger(ledgerOptions);
    this.maintenance = new LcmMaintenance(this.ledger, {
      ...initial,
      ...(initial.lcmMaxInputChars === undefined ? {} : { maxInputChars: initial.lcmMaxInputChars }),
      ...(initial.lcmMaxOutputChars === undefined ? {} : { maxOutputChars: initial.lcmMaxOutputChars }),
      ...(initial.modelTimeoutSeconds === undefined ? {} : { modelTimeoutMs: initial.modelTimeoutSeconds * 1_000 }),
      budget: {
        ...(initial.maxDailyModelCalls ? { calls: initial.maxDailyModelCalls } : {}),
        ...(initial.maxSessionModelCalls ? { sessionCalls: initial.maxSessionModelCalls } : {}),
        ...(initial.maxDailyModelSeconds ? { wallMs: initial.maxDailyModelSeconds * 1_000 } : {}),
      },
    });
  }

  private get options(): LcmRuntimeOptions { return this.resolveOptions(); }

  get projectKey(): string { return this.ledger.project.key; }
  get signal(): AbortSignal { return this.abort.signal; }
  get status(): "healthy" | "degraded" { return this.degradedMessage() === undefined ? "healthy" : "degraded"; }
  get error(): unknown { return this.degradedError; }
  get reconciliation(): LcmReconciliation | undefined { return this.lastReconciliation; }

  private degradedMessage(): string | undefined {
    const faults: string[] = [];
    if (this.degradedError !== undefined) faults.push(String(this.degradedError instanceof Error ? this.degradedError.message : this.degradedError));
    const errors = this.lastReconciliation?.errors ?? 0;
    if (errors > 0) faults.push(`LCM session reconciliation reported ${errors} error(s)`);
    const reasons = this.lastReconciliation?.reasons ?? [];
    if (reasons.length > 0) faults.push(`LCM session reconciliation dropped ${reasons.join("; ")}`);
    const failed = this.recentlyFailedJobs();
    if (failed > 0) faults.push(`LCM maintenance left ${failed} job${failed === 1 ? "" : "s"} failed`);
    return faults.length === 0 ? undefined : faults.join(" · ");
  }

  private recentlyFailedJobs(): number {
    try { return this.maintenance.countJobs("failed", Date.now() - FAILED_JOB_WINDOW_MS); } catch { return 0; }
  }
  markDirty(): void { this.dirty = true; }

  private enqueueWrite(operation: () => void | Promise<void>): Promise<void> {
    const run = this.writePending.then(operation);
    this.writePending = run.catch((error) => { this.degradedError = error; });
    return run;
  }

  private refreshActiveSources(sessionId: string, entries: readonly { id: string }[]): void {
    const ids = new Set(entries.map((entry) => entry.id));
    const latest = new Map<string, RawEntry>();
    for (const entry of this.ledger.readRaw(this.projectKey, sessionId)) {
      if (!ids.has(entry.entryId)) continue;
      const previous = latest.get(entry.entryId);
      if (!previous || previous.revision < entry.revision) latest.set(entry.entryId, entry);
    }
    this.activeSources = new Set(
      [...latest.values()].map((entry) => `${entry.sessionId}:${entry.entryId}:${entry.revision}`),
    );
    this.activeSessionId = sessionId;
  }

  reconcileSelectedSession(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.enqueueWrite(() => {
      const getSessionFile = this.context.sessionManager.getSessionFile;
      if (typeof getSessionFile !== "function") return;
      const sessionFile = getSessionFile.call(this.context.sessionManager);
      if (!sessionFile) return;
      const recorded = this.context.sessionManager.getRecordedCwd?.();
      const cwd = recorded || this.context.cwd;
      const result = reconcileSession({
        agentDir: this.options.rootDir ?? process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME ?? "."}/.omp/agent`,
        ledger: this.ledger,
        files: [sessionFile],
        liveCwd: cwd,
        projectCwd: cwd,
        apply: true,
      });
      this.lastReconciliation = {
        degraded: result.degraded,
        errors: result.counts.errors,
        raced: result.counts.raced,
        drops: result.drops,
        reasons: migrationDropReasons(result.drops),
      };
      if (result.counts.errors === 0) this.reconcileRecoveries = 0;
      const sessionId = this.context.sessionManager.getSessionId();
      this.refreshActiveSources(sessionId, this.context.sessionManager.getBranch());
    });
  }

  private recoverReconciliation(): Promise<void> {
    if ((this.lastReconciliation?.errors ?? 0) === 0) return Promise.resolve();
    if (this.reconcileRecoveries >= MAX_RECONCILE_RECOVERIES) return Promise.resolve();
    this.reconcileRecoveries += 1;
    return this.reconcileSelectedSession();
  }

  readback(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.enqueueWrite(() => {
      if (this.closed) return;
      const entries = this.context.sessionManager.getBranch();
      const sessionId = this.context.sessionManager.getSessionId();
      const branch = this.context.sessionManager.getLeafId();
      const recorded = this.context.sessionManager.getRecordedCwd?.();
      const active = new Set<string>();
      for (const entry of entries) {
        const payloadJson = canonicalLcmPayload(entry);
        const message = entry.type === "message" ? entry.message as { role?: string; content?: unknown } : undefined;
        const stored = this.ledger.appendRaw({
          projectKey: this.projectKey,
          sessionId,
          entryId: entry.id,
          role: message?.role ?? entry.type,
          content: message ? JSON.stringify(message.content ?? "") : payloadJson,
          payloadJson,
          parentEntryId: entry.parentId ?? null,
          branch,
          ...(recorded || this.context.cwd ? { recordedCwd: recorded || this.context.cwd } : {}),
        });
        active.add(`${sessionId}:${stored.entryId}:${stored.revision}`);
      }
      this.activeSources = active;
      this.activeSessionId = sessionId;
      this.dirty = false;
      this.degradedError = undefined;
    });
  }

  async syncAndSchedule(): Promise<void> {
    if (this.closed) return;
    await this.readback();
    await this.recoverReconciliation();
    this.reclaimExpiredLeases();
    if (this.maintenanceTrigger() !== undefined) this.scheduleMaintenance();
  }

  reclaimExpiredLeases(): number {
    if (this.closed) return 0;
    try {
      return this.maintenance.sweepExpiredLeases(LEASE_SWEEP_GRACE_MS).length;
    } catch (error) {
      this.degradedError = error;
      return 0;
    }
  }

  maintenanceTrigger(): LcmMaintenanceTrigger | undefined {
    const sessionId = this.activeSessionId;
    if (this.closed || !sessionId || this.activeSources.size === 0) return undefined;
    try {
      if (!this.maintenance.withinBudget(sessionId)) return undefined;
      if (this.maintenanceOccupancyReached()) return "occupancy";
      if (this.actionableJobs(sessionId, this.context.sessionManager.getLeafId(), 1).length > 0) return "jobs";
      const { active, covered } = this.coverage();
      return active - covered >= Math.max(1, this.options.maxLeafEntries ?? DEFAULT_LEAF_ENTRIES) ? "backlog" : undefined;
    } catch (error) {
      this.degradedError = error;
      return undefined;
    }
  }

  /** Fails open: an unreadable occupancy never disables maintenance. */
  maintenanceOccupancyReached(): boolean {
    const ratio = this.options.softThresholdRatio;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return true;
    let usage: { percent: number | null } | undefined;
    try {
      usage = this.context.getContextUsage?.();
    } catch {
      return true;
    }
    const percent = usage?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return true;
    return percent / 100 >= ratio;
  }

  maintain(): Promise<void> { return this.syncAndSchedule(); }

  scheduleMaintenance(): void {
    if (this.closed) return;
    const run = this.maintenancePending.then(() => this.runMaintenance());
    this.maintenancePending = run.catch((error) => { this.degradedError = error; });
  }

  private actionableJobs(sessionId: string, branch: string | null, limit: number): Array<{ job: LcmJob; node: LcmNode }> {
    const found: Array<{ job: LcmJob; node: LcmNode }> = [];
    if (limit <= 0) return found;
    for (const job of this.maintenance.claimableJobs(sessionId, CLAIMABLE_JOB_LIMIT)) {
      const node = this.maintenance.getNode(job.nodeId);
      if (!node || node.sessionId !== sessionId) continue;
      if (branch !== null && node.branch !== branch && node.branch !== null) continue;
      if (!node.sources.every((source) => this.activeSources.has(this.sourceKey(source)))) continue;
      found.push({ job, node });
      if (found.length >= limit) break;
    }
    return found;
  }

  private async runMaintenance(): Promise<void> {
    if (this.closed || !this.activeSessionId || this.activeSources.size === 0) return;
    const wantsModel = this.options.modelSummaries !== false;
    let model: LcmSummarizer;
    try {
      if (!wantsModel) throw new Error("model summaries are disabled by configuration");
      model = new LcmModelAdapter(this.context, this.options.summaryModel, true, {
        ...(this.options.lcmMaxInputChars === undefined ? {} : { maxInputChars: this.options.lcmMaxInputChars }),
        ...(this.options.lcmMaxOutputTokens === undefined ? {} : { maxOutputTokens: this.options.lcmMaxOutputTokens }),
        ...(this.options.lcmMaxOutputChars === undefined ? {} : { maxOutputChars: this.options.lcmMaxOutputChars }),
      });
    } catch (error) {
      this.degradedError = error;
      model = { modelHash: "unavailable", generate: async () => { throw error instanceof Error ? error : new Error(String(error)); } };
    }
    const fanIn = Math.max(2, this.options.maxCondenseChildren ?? 4);
    const passes = Math.max(1, this.options.maxMaintenancePasses ?? 4);
    const runDeadline = Date.now() + Math.max(1, this.options.maintenanceRunSeconds ?? 60) * 1_000;
    const sessionId = this.activeSessionId;
    const raw = this.ledger.readRaw(this.projectKey, sessionId).filter((entry) =>
      this.activeSources.has(`${entry.sessionId}:${entry.entryId}:${entry.revision}`),
    );
    const inputFor = (node: NonNullable<ReturnType<LcmMaintenance["getNode"]>>): string => {
      if (node.kind === "condensed") return node.children.map((id) => this.maintenance.getNode(id)?.text ?? "").filter(Boolean).join("\n\n");
      return node.sources.map((source) => {
        const entry = this.ledger.readRawEntry(this.projectKey, source.sessionId, source.entryId, source.revision);
        if (!entry || entry.payloadHash !== source.payloadHash) throw new Error("stale source");
        return entry.payloadJson;
      }).join("\n");
    };
    const runJob = async (job: LcmJob, node: LcmNode): Promise<void> => {
      try {
        const input = inputFor(node);
        await this.maintenance.run(job, model, input, this.signal);
      } catch (error) {
        this.degradedError = error;
        try { this.maintenance.recordFailure(job, error); } catch {}
      }
    };
    this.reclaimExpiredLeases();
    for (let pass = 0; pass < passes && !this.closed && Date.now() < runDeadline; pass += 1) {
      const leafCandidate = this.maintenance.createLeaf(this.maintenance.selectLeaf(raw, this.context.sessionManager.getLeafId()));
      const leaf = leafCandidate ? this.maintenance.getNode(leafCandidate.nodeId) : undefined;
      if (leaf?.state === "pending") {
        const job = this.maintenance.jobForNode(leaf.nodeId);
        if (job && this.maintenance.isClaimable(job)) await runJob(job, leaf);
      }
      const pending = this.actionableJobs(sessionId, this.context.sessionManager.getLeafId(), passes);
      for (const item of pending) await runJob(item.job, item.node);
      const children = this.maintenance.selectCondensation(sessionId, this.activeSources, this.context.sessionManager.getLeafId());
      if (children.length >= fanIn) {
        const node = this.maintenance.createCondensed(children);
        if (node) {
          const job = this.maintenance.jobForNode(node.nodeId);
          if (job && this.maintenance.isClaimable(job)) await runJob(job, node);
        }
      }
      if (!leaf && pending.length === 0 && children.length < fanIn) {
        const upgrades = this.maintenance.selectUpgrades(sessionId, this.activeSources, this.context.sessionManager.getLeafId(), 1);
        const upgrade = upgrades[0];
        if (!upgrade) break;
        const job = this.maintenance.reopen(upgrade.nodeId);
        await runJob(job, upgrade);
        if (this.maintenance.getNode(upgrade.nodeId)?.modelHash !== "emergency") {
          for (const ancestor of this.maintenance.ancestorsOf(upgrade.nodeId)) {
            const node = this.maintenance.getNode(ancestor);
            if (node?.state === "ready") this.maintenance.reopen(ancestor, true);
          }
        }
        continue;
      }
    }
  }

  compact(input: LcmCompactionInput): LcmCompactionOutput {
    const persistedEntries = new Map<string, RawEntry>();
    for (const entry of input.branchEntries) {
      const message = entry.type === "message" ? entry.message as { role?: string; content?: unknown } : undefined;
      const payloadJson = canonicalLcmPayload(entry);
      const stored = this.ledger.appendRaw({
        projectKey: this.projectKey,
        sessionId: input.sessionId,
        entryId: entry.id,
        role: message?.role ?? entry.type,
        content: message ? JSON.stringify(message.content ?? "") : payloadJson,
        payloadJson,
        parentEntryId: entry.parentId ?? null,
        branch: input.branch,
      });
      persistedEntries.set(`${entry.id}:${stored.payloadHash}`, stored);
    }
    const firstKeptIndex = input.firstKeptEntryId
      ? input.branchEntries.findIndex((entry) => entry.id === input.firstKeptEntryId)
      : input.branchEntries.length;
    const sourceEntries = input.branchEntries.slice(0, firstKeptIndex < 0 ? input.branchEntries.length : firstKeptIndex);
    const selectedStored = sourceEntries.map((entry) => {
      const payloadHash = hashLcmPayload(JSON.parse(canonicalLcmPayload(entry)));
      const stored = persistedEntries.get(`${entry.id}:${payloadHash}`);
      if (!stored) throw new Error("compaction source was not persisted");
      return stored;
    });
    const activeSources = new Set(selectedStored.map((entry) => `${entry.sessionId}:${entry.entryId}:${entry.revision}`));
    const frontier = this.maintenance.getFrontier(input.sessionId, input.branch, activeSources);
    const coveredSources = new Set(frontier.flatMap((node) => node.sources.map((source) => `${source.sessionId}:${source.entryId}:${source.revision}`)));
    const summary = renderAddressedFrontier(frontier);
    if (summary && selectedStored.every((entry) => coveredSources.has(`${entry.sessionId}:${entry.entryId}:${entry.revision}`))) return { summary, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore, source: "ready-frontier", branch: input.branch };
    if (selectedStored.length === 0) throw new Error("LCM emergency fallback has no persisted sources");
    const payloads = sourceEntries.map((entry) => canonicalLcmPayload(entry)).join("\n");
    const sources = selectedStored.map((stored) => ({ sessionId: stored.sessionId, entryId: stored.entryId, revision: stored.revision, payloadHash: stored.payloadHash }));
    const fallback = emergencyReduce(payloads, this.options.lcmMaxOutputChars ?? 4_096, sources);
    const leaf = this.maintenance.createLeaf(selectedStored);
    if (!leaf) throw new Error("LCM emergency fallback node was not created");
    const persisted = this.maintenance.getNode(leaf.nodeId);
    if (persisted?.state === "ready") {
      if (persisted.branch !== input.branch || JSON.stringify(persisted.sources) !== JSON.stringify(sources)) throw new Error("LCM emergency fallback provenance mismatch");
      if (!persisted.text) throw new Error("LCM emergency fallback text is missing");
      return { summary: persisted.text, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore, source: "emergency", branch: input.branch };
    }
    const job = this.maintenance.jobForNode(leaf.nodeId);
    if (!job) throw new Error("LCM emergency fallback job was not created");
    const completed = this.maintenance.completeEmergency(this.maintenance.claimEmergency(job.jobId), fallback);
    return { summary: completed.text ?? fallback, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore, source: "emergency", branch: input.branch };
  }

  report(): LcmReport {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const degraded = this.degradedMessage();
    const ledgerState = this.ledger.operationalState;
    return this.ledger.readOnly((db) => {
      const count = (sql: string, ...params: unknown[]): number =>
        Number((db.prepare(sql).get(...params) as { n: number }).n);
      const nodes = db.prepare("SELECT json_extract(payload,'$.kind') kind, json_extract(payload,'$.state') state, json_extract(payload,'$.modelHash') model, count(*) n FROM summary_nodes WHERE project_key=? GROUP BY kind, state, model")
        .all(this.projectKey) as Array<{ kind: string; state: string; model: string; n: number }>;
      const usage = db.prepare("SELECT coalesce(sum(calls),0) calls, coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output, coalesce(sum(cost),0) cost, coalesce(sum(wall_ms),0) wallMs FROM maintenance_usage WHERE project_key=? AND day=?")
        .get(this.projectKey, day) as { calls: number; input: number; output: number; cost: number; wallMs: number };
      const budget = this.maintenance.budgetPolicy();
      return {
        projectKey: this.projectKey,
        sessionId: this.activeSessionId,
        state: reconcileLcmState(ledgerState, degraded),
        ledgerState,
        degraded,
        summaryModel: this.options.summaryModel,
        rawEntries: count("SELECT count(*) n FROM raw_entries WHERE project_key=?", this.projectKey),
        sessionEntries: this.activeSessionId === undefined ? 0 : count("SELECT count(*) n FROM raw_entries WHERE project_key=? AND session_id=?", this.projectKey, this.activeSessionId),
        modelNodes: nodes.filter((row) => row.model && row.model !== "emergency").reduce((total, row) => total + row.n, 0),
        emergencyNodes: nodes.filter((row) => row.model === "emergency").reduce((total, row) => total + row.n, 0),
        pendingNodes: nodes.filter((row) => row.state !== "ready").reduce((total, row) => total + row.n, 0),
        pendingJobs: count("SELECT count(*) n FROM maintenance_jobs WHERE project_key=? AND status=?", this.projectKey, "pending"),
        upgradableNodes: count("SELECT count(*) n FROM summary_nodes WHERE project_key=? AND json_extract(payload,'$.modelHash')=?", this.projectKey, "emergency"),
        usage: { calls: usage.calls, inputTokens: usage.input, outputTokens: usage.output, cost: usage.cost, wallMs: usage.wallMs },
        budget: { calls: budget.calls, sessionCalls: budget.sessionCalls, wallMs: budget.wallMs },
        reconciliation: this.lastReconciliation,
      };
    });
  }

  private frontierCache: { at: number; sessionId: string; branch: string | null; nodes: LcmNode[]; covered: Set<string> } | undefined;

  /** One frontier walk shared by preview, coverage, and the coverage map. */
  private frontierSnapshot(): { nodes: LcmNode[]; covered: Set<string> } {
    const sessionId = this.activeSessionId ?? "";
    const branch = this.context.sessionManager.getLeafId();
    const cached = this.frontierCache;
    if (cached && cached.sessionId === sessionId && cached.branch === branch && Date.now() - cached.at < 250) {
      return { nodes: cached.nodes, covered: cached.covered };
    }
    const nodes = sessionId ? this.maintenance.getFrontier(sessionId, branch, this.activeSources) : [];
    const covered = new Set(nodes.flatMap(node => node.sources.map(source => this.sourceKey(source))));
    this.frontierCache = { at: Date.now(), sessionId, branch, nodes, covered };
    return { nodes, covered };
  }

  private sourceKey(source: { sessionId: string; entryId: string; revision: number }): string {
    return `${source.sessionId}:${source.entryId}:${source.revision}`;
  }

  /** Assembles what a compaction would serve now. Reads only; it never persists a node. */
  preview(): LcmPreview {
    const sessionId = this.activeSessionId;
    if (!sessionId) return { text: "", nodes: 0, summaryBytes: 0, sourceBytes: 0, coveredSources: 0, activeSources: 0 };
    const { nodes, covered } = this.frontierSnapshot();
    const text = nodes.map(node => node.text ?? "").filter(Boolean).join("\n\n");
    return {
      text,
      nodes: nodes.length,
      summaryBytes: Buffer.byteLength(text, "utf8"),
      sourceBytes: this.ledger.payloadBytes(this.projectKey, sessionId),
      coveredSources: covered.size,
      activeSources: this.activeSources.size,
    };
  }

  /** Ordered coverage of the active branch: each entry says whether a ready node holds it. */
  coverageMap(limit = 2_000): Array<{ key: string; covered: boolean }> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return [];
    const { covered } = this.frontierSnapshot();
    return this.ledger.readRawKeys(this.projectKey, sessionId, limit)
      .map(entry => { const key = this.sourceKey(entry); return { key, covered: covered.has(key) }; });
  }

  nodes(limit = 200, offset = 0): LcmNode[] {
    return this.maintenance.listNodes(limit, offset);
  }

  node(nodeId: string): { node: LcmNode; revisions: ReturnType<LcmMaintenance["revisionsOf"]>; ancestors: string[] } | undefined {
    const node = this.maintenance.getNode(nodeId);
    if (!node) return undefined;
    return { node, revisions: this.maintenance.revisionsOf(nodeId), ancestors: this.maintenance.ancestorsOf(nodeId) };
  }

  source(sessionId: string, entryId: string, revision: number): RawEntry | undefined {
    return this.ledger.readRawEntry(this.projectKey, sessionId, entryId, revision);
  }

  coverage(): { active: number; covered: number } {
    if (!this.activeSessionId) return { active: 0, covered: 0 };
    const { covered } = this.frontierSnapshot();
    let hits = 0;
    for (const key of this.activeSources) if (covered.has(key)) hits += 1;
    return { active: this.activeSources.size, covered: hits };
  }

  memoryContext() {
    return {
      ledger: {
        projectKey: this.projectKey,
        readRaw: (sessionId?: string) => this.ledger.readRaw(this.projectKey, sessionId),
        readRawPage: (sessionId?: string, offset?: number, limit?: number) => this.ledger.readRawPage(this.projectKey, sessionId, offset, limit),
        readRawEntry: (sessionId: string, entryId: string, revision: number) => this.ledger.readRawEntry(this.projectKey, sessionId, entryId, revision),
        searchRaw: (options: Parameters<LcmLedger["searchRaw"]>[1]) => this.ledger.searchRaw(this.projectKey, options),
      },
      ...(this.activeSessionId === undefined ? {} : { currentSessionId: this.activeSessionId }),
      summaries: {
        listNodes: ({ sessionId, branch, limit }: { sessionId?: string; branch?: string | null; limit: number }) => this.maintenance.getFrontier(sessionId, branch, sessionId === this.activeSessionId ? this.activeSources : undefined).slice(0, limit).map((node) => ({ ...node, text: node.text ?? "", sources: node.sources.map((source) => ({ entryId: source.entryId, revision: source.revision, contentHash: source.payloadHash })) })),
        getNode: (nodeId: string) => {
          const node = this.maintenance.getNode(nodeId);
          return node ? { ...node, text: node.text ?? "", sources: node.sources.map((source) => ({ entryId: source.entryId, revision: source.revision, contentHash: source.payloadHash })) } : undefined;
        },
      },
      branchForSession: (sessionId: string) => sessionId === this.activeSessionId
        ? { branch: this.context.sessionManager.getLeafId(), activeSourceKeys: [...this.activeSources], ready: this.status === "healthy" }
        : undefined,
    };
  }

  frontier(sessionId?: string, branch?: string | null) {
    return this.maintenance.getFrontier(sessionId, branch, sessionId === this.activeSessionId ? this.activeSources : undefined);
  }

  raw(sessionId?: string): RawEntry[] { return this.ledger.readRaw(this.projectKey, sessionId); }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await this.writePending.catch(() => undefined);
    await this.maintenancePending.catch(() => undefined);
    this.ledger.close();
  }
}
