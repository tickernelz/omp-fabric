import { hashLcmPayload, type RawEntry } from "../storage/lcm-identity.js";

export interface LcmSummaryNode {
  nodeId: string;
  projectKey: string;
  sessionId: string;
  branch: string | null;
  sourceHash: string;
  lineageFingerprint?: string;
  state: "pending" | "running" | "ready" | "failed";
  text: string;
  children: string[];
  sources: Array<{ entryId: string; revision: number; contentHash: string }>;
  createdAt: number;
}

export interface LcmSummaryReader {
  listNodes(input: { sessionId?: string; branch?: string | null; limit: number }): LcmSummaryNode[];
  getNode(nodeId: string): LcmSummaryNode | undefined;
}

export interface LcmBranchBinding {
  sessionId?: string;
  branch?: string | null;
  sourceHash?: string;
  lineageFingerprint?: string;
  activeSourceKeys?: readonly string[];
  ready: boolean;
}

export interface LcmMemoryLedger {
  readonly projectKey: string;
  readRaw(sessionId?: string): RawEntry[];
  readRawPage(sessionId?: string, offset?: number, limit?: number): RawEntry[];
  readRawEntry(sessionId: string, entryId: string, revision: number): RawEntry | undefined;
}

export interface LcmMemoryAdapterOptions {
  ledger: LcmMemoryLedger;
  summaries: LcmSummaryReader;
  projectKey?: string;
  currentSessionId?: string;
  branchForSession?: (sessionId: string) => LcmBranchBinding | undefined;
  maxRawEntries?: number;
  maxSummaryNodes?: number;
}

interface LcmMemoryHit {
  kind: "lcm.raw" | "lcm.summary";
  sessionId: string;
  score: number;
  snippet: string;
  truncated: boolean;
  source: {
    kind: "raw" | "summary";
    projectKey: string;
    sessionId: string;
    entryId?: string;
    revision?: number;
    contentHash?: string;
    nodeId?: string;
    sourceHash: string;
  };
  follow: { ref: "memory.expand"; args: Record<string, unknown> };
}

interface LcmMemoryResult {
  total: number;
  hits: LcmMemoryHit[];
  next: { ref: "memory.recall"; args: Record<string, unknown> } | null;
  coverage: {
    complete: boolean;
    indexedSessions: number;
    eligibleSessions: number;
    staleSessions: number;
    incompleteSessions: number;
    reasons: string[];
  };
}

const terms = (text: string): string[] => [
  ...new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []),
];

const score = (text: string, query: string | undefined): number => {
  if (!query?.trim()) return 0;
  const available = new Set(terms(text));
  return terms(query).reduce((total, term) => total + (available.has(term) ? 1 : 0), 0);
};

const excerpt = (text: string, max = 480): { snippet: string; truncated: boolean } => ({
  snippet: text.length <= max ? text : text.slice(0, max),
  truncated: text.length > max,
});

const sourceKey = (sessionId: string, entryId: string, revision: number): string =>
  `${sessionId}:${entryId}:${revision}`;

const activeBinding = (
  options: LcmMemoryAdapterOptions,
  sessionId: string,
): LcmBranchBinding | undefined => options.branchForSession?.(sessionId);

const activeSourceSet = (binding: LcmBranchBinding | undefined): Set<string> | undefined =>
  binding?.activeSourceKeys === undefined ? undefined : new Set(binding.activeSourceKeys);

const sessionScope = (args: Record<string, unknown>, currentSessionId: string | undefined): string | undefined => {
  const scope = typeof args.scope === "string" && args.scope.startsWith("session:")
    ? args.scope.slice("session:".length)
    : undefined;
  return scope ?? currentSessionId;
};

const activeAllowed = (
  branches: "active" | "all",
  binding: LcmBranchBinding | undefined,
  key: string,
): { allowed: boolean; reason?: string } => {
  if (branches === "all") return { allowed: true };
  if (!binding) return { allowed: false, reason: "active_branch_unbound" };
  if (!binding.ready) return { allowed: false, reason: "session_incomplete" };
  if (binding.activeSourceKeys !== undefined && !activeSourceSet(binding)?.has(key)) {
    return { allowed: false, reason: "source_off_active_branch" };
  }
  return { allowed: true };
};

export class LcmMemoryAdapter {
  private readonly projectKey: string;
  private readonly maxRaw: number;
  private readonly maxSummary: number;

  constructor(private readonly options: LcmMemoryAdapterOptions) {
    this.projectKey = options.projectKey ?? options.ledger.projectKey;
    this.maxRaw = Math.max(1, Math.min(options.maxRawEntries ?? 1000, 10000));
    this.maxSummary = Math.max(1, Math.min(options.maxSummaryNodes ?? 1000, 10000));
  }

  recall(args: Record<string, unknown>): LcmMemoryResult {
    const query = typeof args.query === "string" ? args.query : undefined;
    const branches = args.branches === "all" ? "all" : "active";
    const offset = typeof args.offset === "number" && args.offset >= 0 ? Math.floor(args.offset) : 0;
    const pageSize = typeof args.pageSize === "number" && args.pageSize >= 1
      ? Math.min(50, Math.floor(args.pageSize))
      : 10;
    const selectedSession = sessionScope(args, this.options.currentSessionId);
    const reasons = new Set<string>();
    const raw = selectedSession === undefined
      ? this.options.ledger.readRawPage(undefined, 0, this.maxRaw + 1)
      : this.options.ledger.readRawPage(selectedSession, 0, this.maxRaw + 1);
    const rawBounded = raw.slice(0, this.maxRaw);
    const summaryBranch = branches === "active" && selectedSession !== undefined ? activeBinding(this.options, selectedSession)?.branch : undefined;
    const summaries = selectedSession === undefined
      ? this.options.summaries.listNodes({ limit: this.maxSummary + 1 })
      : this.options.summaries.listNodes({ sessionId: selectedSession, limit: this.maxSummary + 1, ...(summaryBranch === undefined ? {} : { branch: summaryBranch }) });
    const summaryBounded = summaries.slice(0, this.maxSummary);
    if (raw.length > this.maxRaw) reasons.add("raw_entry_limit");
    if (summaries.length > this.maxSummary) reasons.add("summary_node_limit");
    const hits: LcmMemoryHit[] = [];
    for (const entry of rawBounded) {
      const binding = activeBinding(this.options, entry.sessionId);
      const allowed = activeAllowed(branches, binding, sourceKey(entry.sessionId, entry.entryId, entry.revision));
      if (!allowed.allowed) {
        if (allowed.reason) reasons.add(allowed.reason);
        continue;
      }
      const value = score(entry.content, query);
      if (query && value === 0) continue;
      const preview = excerpt(entry.content);
      hits.push({
        kind: "lcm.raw",
        sessionId: entry.sessionId,
        score: value,
        snippet: preview.snippet,
        truncated: preview.truncated,
        source: {
          kind: "raw",
          projectKey: entry.projectKey,
          sessionId: entry.sessionId,
          entryId: entry.entryId,
          revision: entry.revision,
          contentHash: entry.payloadHash,
          sourceHash: entry.payloadHash,
        },
        follow: {
          ref: "memory.expand",
          args: {
            session: `lcm.raw:${entry.sessionId}:${entry.entryId}:${entry.revision}`,
            branches,
            expectedSourceHash: entry.payloadHash,
          },
        },
      });
    }
    for (const node of summaryBounded) {
      if (node.state !== "ready") {
        reasons.add(`summary_${node.state}`);
        continue;
      }
      const binding = activeBinding(this.options, node.sessionId);
      if (branches === "active") {
        if (!binding) {
          reasons.add("active_branch_unbound");
          continue;
        }
        if (!binding.ready) {
          reasons.add("session_incomplete");
          continue;
        }
        const active = activeSourceSet(binding);
        if (active && node.sources.some((source) => !active.has(sourceKey(node.sessionId, source.entryId, source.revision)))) {
          reasons.add("summary_off_active_branch");
          continue;
        }
      }
      const value = score(node.text, query);
      if (query && value === 0) continue;
      const preview = excerpt(node.text);
      hits.push({
        kind: "lcm.summary",
        sessionId: node.sessionId,
        score: value,
        snippet: preview.snippet,
        truncated: preview.truncated,
        source: {
          kind: "summary",
          projectKey: node.projectKey,
          sessionId: node.sessionId,
          nodeId: node.nodeId,
          sourceHash: node.sourceHash,
        },
        follow: {
          ref: "memory.expand",
          args: { session: `lcm.summary:${node.nodeId}`, branches, expectedSourceHash: node.sourceHash },
        },
      });
    }
    hits.sort((left, right) => right.score - left.score
      || left.sessionId.localeCompare(right.sessionId)
      || left.source.kind.localeCompare(right.source.kind)
      || String(left.source.entryId ?? left.source.nodeId).localeCompare(String(right.source.entryId ?? right.source.nodeId)));
    const page = hits.slice(offset, offset + pageSize);
    return {
      total: hits.length,
      hits: page,
      next: offset + page.length < hits.length
        ? { ref: "memory.recall", args: { ...args, offset: offset + page.length } }
        : null,
      coverage: {
        complete: reasons.size === 0,
        indexedSessions: new Set(hits.map((hit) => hit.sessionId)).size,
        eligibleSessions: new Set(hits.map((hit) => hit.sessionId)).size,
        staleSessions: 0,
        incompleteSessions: reasons.size === 0 ? 0 : 1,
        reasons: [...reasons].sort(),
      },
    };
  }

  expand(args: Record<string, unknown>): Record<string, unknown> {
    const address = typeof args.session === "string" ? args.session : "";
    const branches = args.branches === "all" ? "all" : "active";
    if (address.startsWith("lcm.summary:")) {
      const node = this.options.summaries.getNode(address.slice("lcm.summary:".length));
      if (!node) return { entries: [], next: null, error: { code: "stale_pointer", message: "summary node is unavailable" } };
      if (node.state !== "ready") return { entries: [], next: null, error: { code: "incomplete_coverage", message: `summary node is ${node.state}` } };
      const binding = activeBinding(this.options, node.sessionId);
      if (branches === "active") {
        if (!binding || !binding.ready) return { entries: [], next: null, error: { code: "incomplete_coverage", message: "summary lineage is not ready" } };
        const active = activeSourceSet(binding);
        if (active && node.sources.some((source) => !active.has(sourceKey(node.sessionId, source.entryId, source.revision)))) {
          return { entries: [], next: null, error: { code: "stale_pointer", message: "summary is outside the active branch" } };
        }
      }
      const expected = typeof args.expectedSourceHash === "string" ? args.expectedSourceHash : undefined;
      if (expected && expected !== node.sourceHash) return { entries: [], next: null, error: { code: "stale_pointer", message: "summary source hash changed", expectedSourceHash: expected, actualSourceHash: node.sourceHash } };
      return {
        session: address,
        sourceHash: node.sourceHash,
        branches,
        lineageFingerprint: node.lineageFingerprint ?? null,
        entryCount: 1,
        entries: [{
          index: 0,
          entryId: node.nodeId,
          parentId: null,
          type: "summary",
          role: "compactionSummary",
          timestamp: node.createdAt,
          isError: false,
          text: node.text,
          textRange: { start: 0, end: node.text.length, total: node.text.length, complete: true },
          anchor: true,
          structuredContent: { nodeId: node.nodeId, sourceHash: node.sourceHash, children: node.children, sources: node.sources },
        }],
        next: null,
      };
    }
    const parts = address.split(":");
    if (parts.length < 4 || parts[0] !== "lcm.raw") return { entries: [], next: null, error: { code: "invalid_address", message: "invalid LCM raw address" } };
    const revision = Number(parts.at(-1));
    const entryId = parts.slice(2, -1).join(":");
    const sessionId = parts[1];
    if (!sessionId || !entryId || !Number.isSafeInteger(revision) || revision < 1) return { entries: [], next: null, error: { code: "invalid_address", message: "invalid LCM raw address" } };
    const entry = this.options.ledger.readRawEntry(sessionId, entryId, revision);
    if (!entry) return { entries: [], next: null, error: { code: "stale_pointer", message: "raw source is unavailable" } };
    const binding = activeBinding(this.options, sessionId);
    const allowed = activeAllowed(branches, binding, sourceKey(sessionId, entryId, revision));
    if (!allowed.allowed) return { entries: [], next: null, error: { code: allowed.reason === "source_off_active_branch" ? "stale_pointer" : "incomplete_coverage", message: allowed.reason ?? "raw lineage is unavailable" } };
    const payload = JSON.parse(entry.payloadJson) as Record<string, unknown>;
    const sourceHash = hashLcmPayload(payload);
    const expected = typeof args.expectedSourceHash === "string" ? args.expectedSourceHash : undefined;
    if (expected && expected !== sourceHash) return { entries: [], next: null, error: { code: "stale_pointer", message: "raw source hash changed", expectedSourceHash: expected, actualSourceHash: sourceHash } };
    const max = typeof args.maxChars === "number" ? Math.min(24000, Math.max(256, Math.floor(args.maxChars))) : 20000;
    const start = typeof args.textOffset === "number" ? Math.max(0, Math.floor(args.textOffset)) : 0;
    const text = entry.content.slice(start, start + max);
    const complete = start + text.length >= entry.content.length;
    return {
      session: address,
      sourceHash,
      branches,
      entryCount: 1,
      entries: [{
        index: 0,
        entryId: entry.entryId,
        parentId: entry.parentEntryId,
        type: "raw",
        role: entry.role,
        timestamp: entry.createdAt,
        isError: false,
        text,
        textRange: { start, end: start + text.length, total: entry.content.length, complete },
        anchor: true,
        structuredContent: payload,
      }],
      next: complete ? null : { ref: "memory.expand", args: { ...args, textOffset: start + text.length } },
    };
  }
}
