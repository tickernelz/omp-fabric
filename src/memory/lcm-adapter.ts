import { hash, hashLcmPayload, type RawEntry } from "../storage/lcm-identity.js";
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
  listNodes(input: { sessionId?: string; limit: number }): LcmSummaryNode[];
  getNode(nodeId: string): LcmSummaryNode | undefined;
}

export interface LcmBranchBinding {
  sessionId?: string;
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
  getCurrentSessionId?: () => string | undefined;
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
const SUMMARY_EXPAND_DEFAULT_CHARS = 20000;
const SUMMARY_EXPAND_MAX_CHARS = 24000;
const SUMMARY_EXPAND_MAX_CONTEXT = 100;
const SUMMARY_DESCENT_CACHE_LIMIT = 8;

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

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

const sourceKey = (entryId: string, contentHash: string): string => `${entryId}:${contentHash}`;

const activeBinding = (
  options: LcmMemoryAdapterOptions,
  sessionId: string,
): LcmBranchBinding | undefined => options.branchForSession?.(sessionId);

const activeSourceSet = (binding: LcmBranchBinding | undefined): Set<string> | undefined =>
  binding?.activeSourceKeys === undefined ? undefined : new Set(binding.activeSourceKeys);

export const parseLcmRawAddress = (
  address: string,
): { sessionId: string; entryId: string; revision: number } | undefined => {
  const parts = address.split(":");
  if (parts.length < 4 || parts[0] !== "lcm.raw") return undefined;
  const revision = Number(parts.at(-1));
  const entryId = parts.slice(2, -1).join(":");
  const sessionId = parts[1];
  if (!sessionId || !entryId || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { sessionId, entryId, revision };
};

interface RawFilter {
  search: Pick<LcmSearchOptions, "roles" | "excludeRoles" | "since" | "until" | "order">;
  includeSummaries: boolean;
  since?: number;
  until?: number;
}

const readTime = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const rawFilter = (args: Record<string, unknown>, query: string | undefined, mode: MemoryQueryMode): RawFilter => {
  const role = typeof args.role === "string" && args.role.length > 0 ? args.role : undefined;
  const since = readTime(args.since);
  const until = readTime(args.until);
  const ranked = (query?.trim().length ?? 0) > 0 && mode !== "regex";
  return {
    search: {
      ...(role === undefined ? { excludeRoles: ["custom"] } : { roles: [role] }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      order: ranked ? "relevance" : "recent",
    },
    includeSummaries: role === undefined || role === "compactionSummary",
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
};

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

const addressList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

const unresolvedAddress = (
  addresses: readonly string[],
  items: readonly DescentItem[],
  addressType: "entry_id" | "operation_address",
  read: (item: DescentItem) => string,
): Record<string, unknown> | undefined => {
  for (const address of addresses) {
    const matches = items.reduce((count, item) => count + (read(item) === address ? 1 : 0), 0);
    if (matches === 1) continue;
    return {
      code: matches === 0 ? "address_not_found" : "ambiguous_address",
      message: matches === 0
        ? `Entry address ${JSON.stringify(address)} was not found.`
        : `Entry address ${JSON.stringify(address)} resolves to ${matches} records.`,
      addressType,
      address,
      matches,
    };
  }
  return undefined;
};

const resolveDescentSelection = (
  items: readonly DescentItem[],
  args: Record<string, unknown>,
): { selected: SelectedDescentItem[] } | { error: Record<string, unknown> } => {
  const total = items.length;
  const outOfRange = (message: string) => ({ error: { code: "index_out_of_bounds", message, entryCount: total } });
  const positioned = (): SelectedDescentItem[] => items.map((item, index) => ({ item, index }));

  const requested = args.indices;
  if (requested !== undefined && !Array.isArray(requested)) {
    throw new Error("memory.expand indices must be an array");
  }
  const candidates = (requested ?? []) as unknown[];
  if (!candidates.every((index) => typeof index === "number" && Number.isSafeInteger(index) && index >= 0)) {
    return outOfRange("Every entry index must be a non-negative safe integer.");
  }
  const indices = candidates as number[];
  const beyond = indices.find((index) => index >= total);
  if (beyond !== undefined) {
    return outOfRange(`Entry index ${beyond} is outside 0..${Math.max(0, total - 1)}.`);
  }

  const entryIds = addressList(args.entryIds);
  const addresses = addressList(args.operationAddresses);
  const range = args.entryRange && typeof args.entryRange === "object" && !Array.isArray(args.entryRange)
    ? args.entryRange as Record<string, unknown>
    : undefined;
  const first = range?.first;
  const last = range?.last;
  if ((first === undefined) !== (last === undefined)) {
    throw new Error("memory.expand entryRange requires both first and last");
  }
  if (first !== undefined && (
    typeof first !== "number" ||
    typeof last !== "number" ||
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 0 ||
    last < first
  )) {
    return outOfRange("Entry range requires safe integers with 0 <= first <= last.");
  }
  if (typeof last === "number" && last >= total) {
    return outOfRange(`Entry range ends at ${last}, but the summary descends into ${total} entries.`);
  }

  const before = clampInteger(args.before, 0, SUMMARY_EXPAND_MAX_CONTEXT, 0);
  const after = clampInteger(args.after, 0, SUMMARY_EXPAND_MAX_CONTEXT, 0);
  if (indices.length === 0 && entryIds.length === 0 && addresses.length === 0 && first === undefined) {
    if (before > 0 || after > 0) {
      throw new Error("memory.expand before/after requires one selected anchor");
    }
    return { selected: positioned() };
  }

  const missingEntryId = unresolvedAddress(entryIds, items, "entry_id", (item) => item.entryId);
  if (missingEntryId) return { error: missingEntryId };
  const missingAddress = unresolvedAddress(addresses, items, "operation_address", (item) => item.address);
  if (missingAddress) return { error: missingAddress };

  const indexSet = new Set(indices);
  const entryIdSet = new Set(entryIds);
  const addressSet = new Set(addresses);
  const selected = positioned().filter(({ item, index }) =>
    indexSet.has(index) ||
    entryIdSet.has(item.entryId) ||
    addressSet.has(item.address) ||
    (typeof first === "number" && typeof last === "number" && index >= first && index <= last));
  if (before === 0 && after === 0) return { selected };
  if (selected.length !== 1) {
    throw new Error("memory.expand before/after requires exactly one resolved anchor");
  }
  const anchor = selected[0]!.index;
  const from = Math.max(0, anchor - before);
  const to = Math.min(Math.max(0, total - 1), anchor + after);
  return { selected: positioned().filter(({ index }) => index >= from && index <= to) };
};

export class LcmMemoryAdapter {
  private readonly projectKey: string;
  private readonly maxRaw: number;
  private readonly maxSummary: number;
  private readonly descents = new Map<string, DescentItem[]>();

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
    const selectedSession = sessionScope(args, this.options.getCurrentSessionId?.());
    const filter = rawFilter(args, query, mode);
    const reasons = new Set<string>();
    if (predicate.failure) reasons.add(predicate.failure);

    const summaryHits = filter.includeSummaries
      ? this.summaryHits(selectedSession, branches, predicate, filter, reasons)
      : [];
    const page = this.mergedPage({
      search: {
        ...(selectedSession === undefined ? {} : { sessionId: selectedSession }),
        ...(query === undefined ? {} : { query }),
        mode,
        match,
        ...filter.search,
      },
      branches,
      predicate,
      summaryHits,
      offset,
      pageSize,
      reasons,
    });
    const total = page.rawTotal + summaryHits.length;
    const sessions = new Set(page.hits.map((hit) => hit.sessionId)).size;
    return {
      total,
      hits: page.hits,
      next: !page.exhausted && page.position < total
        ? { ref: "memory.recall", args: { ...args, offset: page.position } }
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

  private mergedPage(input: {
    search: Omit<LcmSearchOptions, "offset" | "limit" | "scanLimit">;
    branches: "active" | "all";
    predicate: QueryPredicate;
    summaryHits: readonly LcmMemoryHit[];
    offset: number;
    pageSize: number;
    reasons: Set<string>;
  }): { hits: LcmMemoryHit[]; position: number; rawTotal: number; exhausted: boolean } {
    const { search, branches, predicate, summaryHits, offset, pageSize, reasons } = input;
    let batch: RawEntry[] = [];
    let batchStart = 0;
    let rawEnd = Number.POSITIVE_INFINITY;
    let rawTotal = 0;
    const rawAt = (position: number): RawEntry | undefined => {
      if (position >= batchStart && position < batchStart + batch.length) return batch[position - batchStart];
      if (position >= rawEnd) return undefined;
      const limit = Math.max(pageSize, 32);
      const page = this.options.ledger.searchRaw({ ...search, offset: position, limit, scanLimit: this.maxRaw });
      rawTotal = page.total;
      if (!page.complete) reasons.add("raw_search_incomplete");
      batch = page.rows;
      batchStart = position;
      if (page.rows.length < limit) rawEnd = position + page.rows.length;
      return batch[0];
    };
    const hits: LcmMemoryHit[] = [];
    let rawPosition = summaryHits.length === 0 ? offset : 0;
    let summaryPosition = 0;
    let position = rawPosition;
    let emittedRaw = 0;
    let headPosition = -1;
    let headScore = 0;
    let exhausted = false;
    while (hits.length < pageSize) {
      if (position >= offset && emittedRaw >= this.maxRaw) {
        if (rawAt(rawPosition) !== undefined) reasons.add("raw_scan_limit");
        break;
      }
      const entry = rawAt(rawPosition);
      const summary = summaryHits[summaryPosition];
      if (entry === undefined && summary === undefined) {
        exhausted = true;
        break;
      }
      if (entry !== undefined && headPosition !== rawPosition) {
        headScore = predicate.scoreOf(entry.content);
        headPosition = rawPosition;
      }
      const emit = position >= offset;
      position += 1;
      if (summary !== undefined && (entry === undefined || summary.score > headScore)) {
        summaryPosition += 1;
        if (emit) hits.push(summary);
        continue;
      }
      rawPosition += 1;
      if (!emit) continue;
      emittedRaw += 1;
      const allowed = activeAllowed(branches, activeBinding(this.options, entry!.sessionId), sourceKey(entry!.entryId, entry!.contentHash));
      if (!allowed.allowed) {
        if (allowed.reason) reasons.add(allowed.reason);
        continue;
      }
      hits.push(this.rawHit(entry!, headScore, branches));
    }
    return { hits, position, rawTotal, exhausted };
  }

  private rawHit(entry: RawEntry, score: number, branches: "active" | "all"): LcmMemoryHit {
    const preview = excerpt(entry.content);
    const address = lcmRawAddress(entry);
    return {
      kind: "lcm.raw",
      sessionId: entry.sessionId,
      score,
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
    filter: RawFilter,
    reasons: Set<string>,
  ): LcmMemoryHit[] {
    const nodes = selectedSession === undefined
      ? this.options.summaries.listNodes({ limit: this.maxSummary + 1 })
      : this.options.summaries.listNodes({ sessionId: selectedSession, limit: this.maxSummary + 1 });
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
        if (active && node.sources.some((source) => !active.has(sourceKey(source.entryId, source.contentHash)))) {
          reasons.add("summary_off_active_branch");
          continue;
        }
      }
      if (filter.since !== undefined && node.createdAt < filter.since) continue;
      if (filter.until !== undefined && node.createdAt > filter.until) continue;
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
      if (active && node.sources.some((source) => !active.has(sourceKey(source.entryId, source.contentHash)))) {
        return { entries: [], next: null, error: { code: "stale_pointer", message: "summary is outside the active branch" } };
      }
    }
    const expected = typeof args.expectedSourceHash === "string" ? args.expectedSourceHash : undefined;
    if (expected && expected !== node.sourceHash) {
      return { entries: [], next: null, error: { code: "stale_pointer", message: "summary source hash changed", expectedSourceHash: expected, actualSourceHash: node.sourceHash } };
    }
    const expectedLineage = typeof args.expectedLineageFingerprint === "string" ? args.expectedLineageFingerprint : undefined;
    const actualLineage = node.lineageFingerprint ?? null;
    if (expectedLineage !== undefined && expectedLineage !== actualLineage) {
      return { entries: [], next: null, error: { code: "stale_pointer", message: "summary active lineage changed", expectedLineageFingerprint: expectedLineage, actualLineageFingerprint: actualLineage } };
    }
    const offset = clampInteger(args.entryOffset, 0, Number.MAX_SAFE_INTEGER, 0);
    const textOffset = clampInteger(args.textOffset, 0, Number.MAX_SAFE_INTEGER, 0);
    const maxEntries = clampInteger(args.maxEntries, 1, SUMMARY_EXPAND_MAX_ENTRIES, SUMMARY_EXPAND_DEFAULT_ENTRIES);
    const maxChars = clampInteger(args.maxChars, 256, SUMMARY_EXPAND_MAX_CHARS, SUMMARY_EXPAND_DEFAULT_CHARS);
    const descent = node.sources.length > 0
      ? this.constituentEntries(node, branches, active)
      : this.childEntries(node, branches);
    const total = descent.items.length;
    const refused = (error: Record<string, unknown>): Record<string, unknown> => ({
      session: address,
      sourceHash: node.sourceHash,
      branches,
      lineageFingerprint: actualLineage,
      total,
      entryCount: total,
      entries: [],
      next: null,
      error,
    });
    const selection = resolveDescentSelection(descent.items, args);
    if ("error" in selection) return refused(selection.error);
    const selected = selection.selected;
    if (offset > selected.length) {
      return refused({
        code: "index_out_of_bounds",
        message: `Entry offset ${offset} is outside 0..${selected.length}.`,
        entryCount: total,
      });
    }
    if (offset < selected.length && textOffset > selected[offset]!.item.text.length) {
      return refused({
        code: "text_offset_out_of_bounds",
        message: `Text offset ${textOffset} exceeds entry #${selected[offset]!.index} length ${selected[offset]!.item.text.length}.`,
        textLength: selected[offset]!.item.text.length,
      });
    }
    const entries: Array<Record<string, unknown>> = [];
    let cursor = offset;
    let start = textOffset;
    let budget = maxChars;
    while (cursor < selected.length && entries.length < maxEntries && budget > 0) {
      const { item, index } = selected[cursor]!;
      let stop = Math.min(item.text.length, start + budget);
      if (stop < item.text.length && isLowSurrogate(item.text.charCodeAt(stop))) {
        stop = stop - 1 > start ? stop - 1 : Math.min(item.text.length, stop + 1);
      }
      const text = item.text.slice(start, stop);
      const end = start + text.length;
      const complete = end >= item.text.length;
      entries.push({
        index,
        entryId: item.entryId,
        parentId: item.parentId,
        type: item.type,
        role: item.role,
        timestamp: item.timestamp,
        isError: false,
        text,
        textRange: { start, end, total: item.text.length, complete },
        anchor: true,
        address: item.address,
        sourceHash: item.sourceHash,
        follow: {
          ref: "memory.expand",
          args: { session: item.address, branches, expectedSourceHash: item.sourceHash },
        },
      });
      budget -= text.length;
      if (!complete) {
        start = end;
        break;
      }
      cursor += 1;
      start = 0;
    }
    return {
      session: address,
      sourceHash: node.sourceHash,
      branches,
      lineageFingerprint: actualLineage,
      node: {
        nodeId: node.nodeId,
        sessionId: node.sessionId,
        kind: node.kind ?? (node.sources.length > 0 ? "leaf" : "condensed"),
        state: node.state,
        text: node.text,
        sourceHash: node.sourceHash,
        children: node.children,
        sources: node.sources,
        createdAt: node.createdAt,
      },
      total,
      entryCount: total,
      entries,
      next: cursor < selected.length
        ? { ref: "memory.expand", args: { ...args, entryOffset: cursor, textOffset: start } }
        : null,
      ...(descent.unavailable === 0
        ? {}
        : { error: { code: "incomplete_coverage", message: `${descent.unavailable} constituent source(s) are unavailable` } }),
    };
  }

  private rememberDescent(key: string, items: DescentItem[]): void {
    this.descents.delete(key);
    this.descents.set(key, items);
    while (this.descents.size > SUMMARY_DESCENT_CACHE_LIMIT) {
      const oldest = this.descents.keys().next().value;
      if (oldest === undefined) break;
      this.descents.delete(oldest);
    }
  }

  private constituentEntries(
    node: LcmSummaryNode,
    branches: "active" | "all",
    active: Set<string> | undefined,
  ): { items: DescentItem[]; unavailable: number } {
    const reachable: LcmSummaryNode["sources"] = [];
    let unavailable = 0;
    for (const source of node.sources) {
      const key = sourceKey(source.entryId, source.contentHash);
      if (branches === "active" && active && !active.has(key)) {
        unavailable += 1;
        continue;
      }
      reachable.push(source);
    }
    const descentKey = hash([
      node.nodeId,
      node.sessionId,
      node.sourceHash,
      ...reachable.map((source) => `${source.entryId}:${source.revision}:${source.contentHash}`),
    ].join("|"));
    const memoized = this.descents.get(descentKey);
    if (memoized) return { items: memoized, unavailable };
    const items: DescentItem[] = [];
    let missing = 0;
    for (const source of reachable) {
      const entry = this.options.ledger.readRawEntry(node.sessionId, source.entryId, source.revision);
      if (!entry) {
        missing += 1;
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
    if (missing === 0) this.rememberDescent(descentKey, items);
    return { items, unavailable: unavailable + missing };
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
      if (branches === "active" && child.sources.some((source) => !activeAllowed(branches, activeBinding(this.options, child.sessionId), sourceKey(source.entryId, source.contentHash)).allowed)) {
        unavailable += 1;
        continue;
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
    const parsed = parseLcmRawAddress(address);
    if (!parsed) return { entries: [], next: null, error: { code: "invalid_address", message: "invalid LCM raw address" } };
    const { sessionId, entryId, revision } = parsed;
    const entry = this.options.ledger.readRawEntry(sessionId, entryId, revision);
    if (!entry) return { entries: [], next: null, error: { code: "stale_pointer", message: "raw source is unavailable" } };
    const binding = activeBinding(this.options, sessionId);
    const allowed = activeAllowed(branches, binding, sourceKey(entryId, entry.contentHash));
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

interface SelectedDescentItem {
  item: DescentItem;
  index: number;
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
