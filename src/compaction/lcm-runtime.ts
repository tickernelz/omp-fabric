import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { canonicalLcmPayload, canonicalProjectIdentity, hashLcmPayload, LcmLedger, type RawEntry } from "../storage/lcm-ledger.js";
import { reconcileSession } from "../storage/lcm-migration.js";
import { clipUtf8, MAX_SUMMARY_BYTES, utf8Bytes } from "./bounds.js";
import { lcmSummaryAddress, renderLcmChildAddresses, renderLcmSourceAddresses } from "./lcm-addresses.js";
import { emergencyReduce, LcmModelAdapter, type LcmSummarizer } from "./lcm-model.js";
import { LCM_RECOVERY_POINTER } from "./render.js";
import { LcmMaintenance, type LcmBudgetPolicy, type LcmJob, type LcmNode } from "./lcm-maintenance.js";
import type { LcmCompactionInput, LcmCompactionOutput } from "./hook.js";

export interface LcmPreview {
  text: string;
  nodes: number;
  summaryBytes: number;
  sourceBytes: number;
  coveredSources: number;
  activeSources: number;
}

export interface LcmReport {
  projectKey: string;
  sessionId: string | undefined;
  state: string;
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

const NODE_ADDRESS_LABEL = "address: ";

export const renderAddressedFrontier = (frontier: readonly LcmNode[]): string => {
  const blocks = frontier
    .filter((node) => Boolean(node.text))
    .map((node) => ({ node, head: `${node.text ?? ""}\n${NODE_ADDRESS_LABEL}${lcmSummaryAddress(node.nodeId)}` }));
  if (blocks.length === 0) return "";
  const footer = `\n\n${LCM_RECOVERY_POINTER}`;
  const mandatory = utf8Bytes(blocks.map((block) => block.head).join("\n\n")) + utf8Bytes(footer);
  const perNode = Math.max(0, Math.floor((MAX_SUMMARY_BYTES - mandatory) / blocks.length) - 1);
  const rendered = blocks.map(({ node, head }) => {
    const addresses = node.sources.length > 0
      ? renderLcmSourceAddresses(node.sources, perNode)
      : renderLcmChildAddresses(node.children, perNode);
    return addresses ? `${head}\n${addresses}` : head;
  });
  const summary = `${rendered.join("\n\n")}${footer}`;
  return utf8Bytes(summary) <= MAX_SUMMARY_BYTES ? summary : clipUtf8(summary, MAX_SUMMARY_BYTES, "");
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
  get status(): "healthy" | "degraded" { return this.degradedError === undefined ? "healthy" : "degraded"; }
  get error(): unknown { return this.degradedError; }
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
      this.degradedError = result.counts.errors > 0
        ? new Error(`LCM session reconciliation reported ${result.counts.errors} error(s)`)
        : undefined;
      const sessionId = this.context.sessionManager.getSessionId();
      this.refreshActiveSources(sessionId, this.context.sessionManager.getBranch());
    });
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
    if (this.maintenanceOccupancyReached()) this.scheduleMaintenance();
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
      try { await this.maintenance.run(job, model, inputFor(node), this.signal); } catch {}
    };
    for (let pass = 0; pass < passes && !this.closed && Date.now() < runDeadline; pass += 1) {
      const leafCandidate = this.maintenance.createLeaf(this.maintenance.selectLeaf(raw, this.context.sessionManager.getLeafId()));
      const leaf = leafCandidate ? this.maintenance.getNode(leafCandidate.nodeId) : undefined;
      if (leaf?.state === "pending") {
        const job = this.maintenance.listJobs().find((item) => item.nodeId === leaf.nodeId);
        if (job) await runJob(job, leaf);
      }
      const branch = this.context.sessionManager.getLeafId();
      const pending = this.maintenance.listJobs().filter((job) => job.state === "pending").flatMap((job) => {
        const node = this.maintenance.getNode(job.nodeId);
        if (!node || node.sessionId !== sessionId || (branch !== null && node.branch !== branch && node.branch !== null) || !node.sources.every((source) => this.activeSources.has(`${source.sessionId}:${source.entryId}:${source.revision}`))) return [];
        return [{ job, node }];
      }).slice(0, passes);
      for (const item of pending) await runJob(item.job, item.node);
      const children = this.maintenance.selectCondensation(sessionId, this.activeSources, this.context.sessionManager.getLeafId());
      if (children.length >= fanIn) {
        const node = this.maintenance.createCondensed(children);
        if (node) {
          const job = this.maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
          if (job) await runJob(job, node);
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
    const job = this.maintenance.listJobs().find((item) => item.nodeId === leaf.nodeId);
    if (!job) throw new Error("LCM emergency fallback job was not created");
    const completed = this.maintenance.completeEmergency(this.maintenance.claimEmergency(job.jobId), fallback);
    return { summary: completed.text ?? fallback, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore, source: "emergency", branch: input.branch };
  }

  report(): LcmReport {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
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
        state: this.ledger.operationalState,
        degraded: this.degradedError === undefined ? undefined : String(this.degradedError instanceof Error ? this.degradedError.message : this.degradedError),
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
