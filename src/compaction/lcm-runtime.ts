import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { canonicalLcmPayload, canonicalProjectIdentity, hashLcmPayload, LcmLedger, type RawEntry } from "../storage/lcm-ledger.js";
import { reconcileSession } from "../storage/lcm-migration.js";
import { emergencyReduce, LcmModelAdapter, type LcmSummarizer } from "./lcm-model.js";
import { LcmMaintenance, type LcmJob, type LcmNode } from "./lcm-maintenance.js";
import type { LcmCompactionInput, LcmCompactionOutput } from "./hook.js";

export interface LcmRuntimeOptions {
  rootDir?: string;
  summaryModel?: string;
  maxLeafEntries?: number;
  maxCondenseChildren?: number;
  lcmMaxInputChars?: number;
  lcmMaxOutputTokens?: number;
  lcmMaxOutputChars?: number;
}

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
    this.scheduleMaintenance();
  }

  maintain(): Promise<void> { return this.syncAndSchedule(); }

  scheduleMaintenance(): void {
    if (this.closed) return;
    const run = this.maintenancePending.then(() => this.runMaintenance());
    this.maintenancePending = run.catch((error) => { this.degradedError = error; });
  }

  private async runMaintenance(): Promise<void> {
    if (this.closed || !this.activeSessionId || this.activeSources.size === 0) return;
    let model: LcmSummarizer;
    try {
      model = new LcmModelAdapter(this.context, this.options.summaryModel, true, {
        ...(this.options.lcmMaxInputChars === undefined ? {} : { maxInputChars: this.options.lcmMaxInputChars }),
        ...(this.options.lcmMaxOutputTokens === undefined ? {} : { maxOutputTokens: this.options.lcmMaxOutputTokens }),
        ...(this.options.lcmMaxOutputChars === undefined ? {} : { maxOutputChars: this.options.lcmMaxOutputChars }),
      });
    } catch (error) {
      this.degradedError = error;
      model = { modelHash: "unavailable", generate: async () => { throw error instanceof Error ? error : new Error(String(error)); } };
    }
    const budget = Math.max(1, this.options.maxCondenseChildren ?? 4);
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
    for (let pass = 0; pass < budget && !this.closed; pass += 1) {
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
      }).slice(0, budget);
      for (const item of pending) await runJob(item.job, item.node);
      const children = this.maintenance.selectCondensation(sessionId, this.activeSources, this.context.sessionManager.getLeafId());
      if (children.length >= budget) {
        const node = this.maintenance.createCondensed(children);
        if (node) {
          const job = this.maintenance.listJobs().find((item) => item.nodeId === node.nodeId);
          if (job) await runJob(job, node);
        }
      }
      if (!leaf && pending.length === 0 && children.length < budget) break;
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
    const summary = frontier.map((node) => node.text ?? "").filter(Boolean).join("\n\n");
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

  memoryContext() {
    return {
      ledger: {
        projectKey: this.projectKey,
        readRaw: (sessionId?: string) => this.ledger.readRaw(this.projectKey, sessionId),
        readRawPage: (sessionId?: string, offset?: number, limit?: number) => this.ledger.readRawPage(this.projectKey, sessionId, offset, limit),
        readRawEntry: (sessionId: string, entryId: string, revision: number) => this.ledger.readRawEntry(this.projectKey, sessionId, entryId, revision),
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
