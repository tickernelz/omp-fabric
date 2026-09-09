import { hashLcmPayload, type RawEntry } from "../storage/lcm-identity.js";
import type { LcmSearchOptions, LcmSearchPage } from "../storage/lcm-ledger.js";
import { lcmRawAddress, lcmSummaryAddress } from "../compaction/lcm-addresses.js";
import { DEFAULT_REGEX_MAX_PATTERN_BYTES } from "./search.js";
import {
  normalizeMemoryPhrase,
  planMemoryQuery,
  tokenizeLexical,
  type MemoryQueryMatch,
  type MemoryQueryMode,
} from "./tokenize.js";

export interface LcmSummaryNode {
  nodeId: string;
  projectKey: string;
  sessionId: string;
  branch: string | null;
  kind?: "leaf" | "condensed";
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
  searchRaw(options: LcmSearchOptions): LcmSearchPage;
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

interface QueryPredicate {
  matches: (text: string) => boolean;
  scoreOf: (text: string) => number;
  failure?: string;
}

const SUMMARY_EXPAND_DEFAULT_ENTRIES = 10;
const SUMMARY_EXPAND_MAX_ENTRIES = 20;
const SUMMARY_EXPAND_DEFAULT_CHARS = 4000;
const SUMMARY_EXPAND_MAX_CHARS = 24000;

const queryPredicate = (
  query: string | undefined,
  mode: MemoryQueryMode,
  match: MemoryQueryMatch,
): QueryPredicate => {
  const plan = planMemoryQuery(query, mode, match);
  if (plan.kind === "browse") {
    return { matches: () => true, scoreOf: () => 0 };
  }
  if (plan.kind === "regex") {
    if (Buffer.byteLength(plan.pattern, "utf8") > DEFAULT_REGEX_MAX_PATTERN_BYTES) {
      return { matches: () => false, scoreOf: () => 0, failure: "regex_pattern_too_large" };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(plan.pattern, "iu");
    } catch {
      return { matches: () => false, scoreOf: () => 0, failure: "invalid_regex" };
    }
    return { matches: (text) => regex.test(text), scoreOf: (text) => (regex.test(text) ? 1 : 0) };
  }
  if (plan.kind === "phrase") {
    const phrase = plan.phrase;
    const hit = (text: string): boolean => normalizeMemoryPhrase(text).includes(phrase);
    return { matches: hit, scoreOf: (text) => (hit(text) ? 1 : 0) };
  }
  const terms = plan.terms;
  if (terms.length === 0) return { matches: () => true, scoreOf: () => 0 };
  const overlap = (text: string): number => {
    const available = new Set(tokenizeLexical(text));
    return terms.reduce((total, term) => total + (available.has(term) ? 1 : 0), 0);
  };
  return plan.match === "all"
    ? { matches: (text) => overlap(text) === terms.length, scoreOf: overlap }
    : { matches: (text) => overlap(text) > 0, scoreOf: overlap };
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

const readMode = (value: unknown): MemoryQueryMode =>
  value === "phrase" ? "phrase" : value === "regex" ? "regex" : "literal";

const readMatch = (value: unknown): MemoryQueryMatch => (value === "all" ? "all" : "any");

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

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
    const mode = readMode(args.queryMode);
    const match = readMatch(args.queryMatch);
    const predicate = queryPredicate(query, mode, match);
    const branches = args.branches === "all" ? "all" : "active";
    const offset = typeof args.offset === "number" && args.offset >= 0 ? Math.floor(args.offset) : 0;
    const pageSize = typeof args.pageSize === "number" && args.pageSize >= 1
      ? Math.min(50, Math.floor(args.pageSize))
      : 10;
    const selectedSession = sessionScope(args, this.options.currentSessionId);
    const reasons = new Set<string>();
    if (predicate.failure) reasons.add(predicate.failure);

    const summaryHits = this.summaryHits(selectedSession, branches, predicate, reasons);
    const raw = this.rawPage(selectedSession, branches, query, mode, match, predicate, offset, pageSize, reasons);
    const hits = raw.hits;
    const consumedPositions = offset + raw.consumed;
    let summaryTaken = 0;
    if (consumedPositions >= raw.total) {
      const start = Math.max(0, consumedPositions - raw.total);
      for (const hit of summaryHits.slice(start)) {
        if (hits.length >= pageSize) break;
        hits.push(hit);
        summaryTaken += 1;
      }
    }
    const total = raw.total + summaryHits.length;
    const consumed = raw.consumed + summaryTaken;
    const sessions = new Set(hits.map((hit) => hit.sessionId)).size;
    return {
      total,
      hits,
      next: offset + consumed < total
        ? { ref: "memory.recall", args: { ...args, offset: offset + consumed } }
        : null,
      coverage: {
        complete: reasons.size === 0,
        indexedSessions: sessions,
        eligibleSessions: sessions,
        staleSessions: 0,
        incompleteSessions: reasons.size === 0 ? 0 : 1,
        reasons: [...reasons].sort(),
      },
    };
  }

  private rawPage(
    selectedSession: string | undefined,
    branches: "active" | "all",
    query: string | undefined,
    mode: MemoryQueryMode,
    match: MemoryQueryMatch,
    predicate: QueryPredicate,
    offset: number,
    pageSize: number,
    reasons: Set<string>,
  ): { hits: LcmMemoryHit[]; consumed: number; total: number } {
    const hits: LcmMemoryHit[] = [];
    let consumed = 0;
    let total = 0;
    while (hits.length < pageSize && consumed < this.maxRaw) {
      const limit = Math.min(Math.max(pageSize, 32), this.maxRaw - consumed);
      const page = this.options.ledger.searchRaw({
        ...(selectedSession === undefined ? {} : { sessionId: selectedSession }),
        ...(query === undefined ? {} : { query }),
        mode,
        match,
        offset: offset + consumed,
        limit,
        scanLimit: this.maxRaw,
      });
      total = page.total;
      if (!page.complete) reasons.add("raw_search_incomplete");
      if (page.rows.length === 0) break;
      for (const entry of page.rows) {
        consumed += 1;
        const allowed = activeAllowed(branches, activeBinding(this.options, entry.sessionId), sourceKey(entry.sessionId, entry.entryId, entry.revision));
        if (!allowed.allowed) {
          if (allowed.reason) reasons.add(allowed.reason);
          continue;
        }
        hits.push(this.rawHit(entry, predicate, branches));
        if (hits.length >= pageSize) break;
      }
      if (page.rows.length < limit) break;
    }
    if (hits.length < pageSize && consumed >= this.maxRaw && offset + consumed < total) {
      reasons.add("raw_scan_limit");
    }
    return { hits, consumed, total };
  }

  private rawHit(entry: RawEntry, predicate: QueryPredicate, branches: "active" | "all"): LcmMemoryHit {
    const preview = excerpt(entry.content);
    const address = lcmRawAddress(entry);
    return {
      kind: "lcm.raw",
      sessionId: entry.sessionId,
      score: predicate.scoreOf(entry.content),
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
        args: { session: address, branches, expectedSourceHash: entry.payloadHash },
      },
    };
  }

  private summaryHits(
    selectedSession: string | undefined,
    branches: "active" | "all",
    predicate: QueryPredicate,
    reasons: Set<string>,
  ): LcmMemoryHit[] {
    const summaryBranch = branches === "active" && selectedSession !== undefined
      ? activeBinding(this.options, selectedSession)?.branch
      : undefined;
    const nodes = selectedSession === undefined
      ? this.options.summaries.listNodes({ limit: this.maxSummary + 1 })
      : this.options.summaries.listNodes({ sessionId: selectedSession, limit: this.maxSummary + 1, ...(summaryBranch === undefined ? {} : { branch: summaryBranch }) });
    if (nodes.length > this.maxSummary) reasons.add("summary_node_limit");
    const hits: Array<{ hit: LcmMemoryHit; createdAt: number; nodeId: string }> = [];
    for (const node of nodes.slice(0, this.maxSummary)) {
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
      if (!predicate.matches(node.text)) continue;
      const preview = excerpt(node.text);
      hits.push({
        createdAt: node.createdAt,
        nodeId: node.nodeId,
        hit: {
          kind: "lcm.summary",
          sessionId: node.sessionId,
          score: predicate.scoreOf(node.text),
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
            args: { session: lcmSummaryAddress(node.nodeId), branches, expectedSourceHash: node.sourceHash },
          },
        },
      });
    }
    hits.sort((left, right) => right.hit.score - left.hit.score
      || right.createdAt - left.createdAt
      || left.nodeId.localeCompare(right.nodeId));
    return hits.map((entry) => entry.hit);
  }

  expand(args: Record<string, unknown>): Record<string, unknown> {
    const address = typeof args.session === "string" ? args.session : "";
    const branches = args.branches === "all" ? "all" : "active";
    if (address.startsWith("lcm.summary:")) return this.expandSummary(address, args, branches);
    return this.expandRaw(address, args, branches);
  }

  private expandSummary(
    address: string,
    args: Record<string, unknown>,
    branches: "active" | "all",
  ): Record<string, unknown> {
    const node = this.options.summaries.getNode(address.slice("lcm.summary:".length));
    if (!node) return { entries: [], next: null, error: { code: "stale_pointer", message: "summary node is unavailable" } };
    if (node.state !== "ready") return { entries: [], next: null, error: { code: "incomplete_coverage", message: `summary node is ${node.state}` } };
    const binding = activeBinding(this.options, node.sessionId);
    const active = activeSourceSet(binding);
    if (branches === "active") {
      if (!binding || !binding.ready) return { entries: [], next: null, error: { code: "incomplete_coverage", message: "summary lineage is not ready" } };
      if (active && node.sources.some((source) => !active.has(sourceKey(node.sessionId, source.entryId, source.revision)))) {
        return { entries: [], next: null, error: { code: "stale_pointer", message: "summary is outside the active branch" } };
      }
    }
    const expected = typeof args.expectedSourceHash === "string" ? args.expectedSourceHash : undefined;
    if (expected && expected !== node.sourceHash) {
      return { entries: [], next: null, error: { code: "stale_pointer", message: "summary source hash changed", expectedSourceHash: expected, actualSourceHash: node.sourceHash } };
    }
    const offset = clampInteger(args.entryOffset, 0, Number.MAX_SAFE_INTEGER, 0);
    const maxEntries = clampInteger(args.maxEntries, 1, SUMMARY_EXPAND_MAX_ENTRIES, SUMMARY_EXPAND_DEFAULT_ENTRIES);
    const maxChars = clampInteger(args.maxChars, 256, SUMMARY_EXPAND_MAX_CHARS, SUMMARY_EXPAND_DEFAULT_CHARS);
    const descent = node.sources.length > 0
      ? this.constituentEntries(node, branches, active)
      : this.childEntries(node, branches);
    const page = descent.items.slice(offset, offset + maxEntries);
    const entries = page.map((item, position) => ({
      index: offset + position,
      entryId: item.entryId,
      parentId: item.parentId,
      type: item.type,
      role: item.role,
      timestamp: item.timestamp,
      isError: false,
      text: item.text.slice(0, maxChars),
      textRange: {
        start: 0,
        end: Math.min(item.text.length, maxChars),
        total: item.text.length,
        complete: item.text.length <= maxChars,
      },
      anchor: true,
      address: item.address,
      sourceHash: item.sourceHash,
      follow: {
        ref: "memory.expand",
        args: { session: item.address, branches, expectedSourceHash: item.sourceHash },
      },
    }));
    const consumed = offset + entries.length;
    return {
      session: address,
      sourceHash: node.sourceHash,
      branches,
      lineageFingerprint: node.lineageFingerprint ?? null,
      node: {
        nodeId: node.nodeId,
        sessionId: node.sessionId,
        branch: node.branch,
        kind: node.kind ?? (node.sources.length > 0 ? "leaf" : "condensed"),
        state: node.state,
        text: node.text,
        sourceHash: node.sourceHash,
        children: node.children,
        sources: node.sources,
        createdAt: node.createdAt,
      },
      total: descent.items.length,
      entryCount: entries.length,
      entries,
      next: consumed < descent.items.length
        ? { ref: "memory.expand", args: { ...args, entryOffset: consumed } }
        : null,
      ...(descent.unavailable === 0
        ? {}
        : { error: { code: "incomplete_coverage", message: `${descent.unavailable} constituent source(s) are unavailable` } }),
    };
  }

  private constituentEntries(
    node: LcmSummaryNode,
    branches: "active" | "all",
    active: Set<string> | undefined,
  ): { items: DescentItem[]; unavailable: number } {
    const items: DescentItem[] = [];
    let unavailable = 0;
    for (const source of node.sources) {
      const key = sourceKey(node.sessionId, source.entryId, source.revision);
      if (branches === "active" && active && !active.has(key)) {
        unavailable += 1;
        continue;
      }
      const entry = this.options.ledger.readRawEntry(node.sessionId, source.entryId, source.revision);
      if (!entry) {
        unavailable += 1;
        continue;
      }
      items.push({
        entryId: entry.entryId,
        parentId: entry.parentEntryId ?? null,
        type: "raw",
        role: entry.role,
        timestamp: entry.createdAt,
        text: entry.content,
        address: lcmRawAddress(entry),
        sourceHash: entry.payloadHash,
      });
    }
    items.sort((left, right) => left.timestamp - right.timestamp
      || left.entryId.localeCompare(right.entryId)
      || left.address.localeCompare(right.address));
    return { items, unavailable };
  }

  private childEntries(
    node: LcmSummaryNode,
    branches: "active" | "all",
  ): { items: DescentItem[]; unavailable: number } {
    const items: DescentItem[] = [];
    let unavailable = 0;
    for (const childId of node.children) {
      const child = this.options.summaries.getNode(childId);
      if (!child || child.state !== "ready") {
        unavailable += 1;
        continue;
      }
      if (branches === "active") {
        const active = activeSourceSet(activeBinding(this.options, child.sessionId));
        if (active && child.sources.some((source) => !active.has(sourceKey(child.sessionId, source.entryId, source.revision)))) {
          unavailable += 1;
          continue;
        }
      }
      items.push({
        entryId: child.nodeId,
        parentId: node.nodeId,
        type: "summary",
        role: "compactionSummary",
        timestamp: child.createdAt,
        text: child.text,
        address: lcmSummaryAddress(child.nodeId),
        sourceHash: child.sourceHash,
      });
    }
    items.sort((left, right) => left.timestamp - right.timestamp || left.entryId.localeCompare(right.entryId));
    return { items, unavailable };
  }

  private expandRaw(
    address: string,
    args: Record<string, unknown>,
    branches: "active" | "all",
  ): Record<string, unknown> {
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
        address,
        sourceHash,
        structuredContent: payload,
      }],
      next: complete ? null : { ref: "memory.expand", args: { ...args, textOffset: start + text.length } },
    };
  }
}

interface DescentItem {
  entryId: string;
  parentId: string | null;
  type: "raw" | "summary";
  role: string;
  timestamp: number;
  text: string;
  address: string;
  sourceHash: string;
}
