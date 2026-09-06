import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import type { FabricMemoryConfig } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import {
  AmbiguousSessionError,
  enumerateAllSessions,
  resolveScope,
  resolveSessionTarget,
  type ResolveScopeInput,
  type SessionRef,
} from "../memory/discovery.js";
import {
  presentRecall,
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DEFAULT_SNIPPET_CHARS,
  RECALL_MAX_PAGE_SIZE,
  RECALL_MAX_RESPONSE_CHARS,
  RECALL_MAX_SNIPPET_CHARS,
  type MemoryRecallCallArgs,
} from "../memory/context.js";
import type { LiveSessionBranch, MemoryBranches } from "../memory/lineage.js";
import { reconstructSessionLineage } from "../memory/lineage.js";
import {
  expandSessionEntriesChecked,
  normalizeSession,
  type ExpandedSessionEntry,
  type ExpandSessionSelection,
  type NormalizedEntry,
} from "../memory/normalize.js";
import {
  DEFAULT_HOT_SESSIONS,
  fingerprintSource,
  loadTieredIndex,
  type EntryRange,
  type MemoryCoverage,
  type MemoryIndexOptions,
  type SearchFilters,
} from "../memory/index.js";
import {
  DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
  DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
  DEFAULT_REGEX_MAX_PATTERN_BYTES,
  DEFAULT_REGEX_TIMEOUT_MS,
  searchMemoryIndex,
  type SearchResult,
} from "../memory/search.js";
import type { MemoryQueryMatch, MemoryQueryMode } from "../memory/tokenize.js";
import { actionArgNormalizer, type ArgNormalizationSpec } from "./arg-normalization.js";

const EXPAND_DEFAULT_MAX_CHARS = 20_000;
const EXPAND_MAX_CHARS = 24_000;
const EXPAND_DEFAULT_MAX_ENTRIES = 10;
const EXPAND_MAX_ENTRIES = 20;
const EXPAND_MAX_CONTEXT = 100;
const EXPAND_MAX_EXACT_SELECTORS = 100;
const SESSIONS_MAX = 500;
const CONTINUATION_CACHE_TTL_MS = 5 * 60_000;
const EXPANSION_SNAPSHOT_LIMIT = 2;
const EXPANSION_SELECTION_LIMIT = 16;

interface SourceIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface SourceObservation {
  file: string;
  identity: SourceIdentity;
  liveBranchSignature: string | null;
}

type LiveBranchResolver = MemoryIndexOptions["liveBranchForFile"];

type CanonicalExpansionSelection = ExpandSessionSelection & {
  before?: number;
  after?: number;
};

interface ResolvedExpansionSelection {
  entries: ExpandedSessionEntry[];
  canonical: CanonicalExpansionSelection;
  anchorIndex: number | null;
}

interface ExpansionSnapshot {
  file: string;
  branches: MemoryBranches;
  sourceHash: string;
  lineageFingerprint: string;
  observation: SourceObservation;
  entries: readonly NormalizedEntry[];
  selections: Map<string, ResolvedExpansionSelection>;
  touchedAt: number;
}

interface RecallContinuationCache {
  key: string;
  result: SearchResult;
  coverage: MemoryCoverage;
  requestArgs: MemoryRecallCallArgs;
  observations: SourceObservation[];
  touchedAt: number;
}

const sourceIdentity = (file: string): SourceIdentity | null => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    return {
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedAt: stat.mtimeNs,
      changedAt: stat.ctimeNs,
    };
  } catch {
    return null;
  }
};

const sameSourceIdentity = (left: SourceIdentity, right: SourceIdentity): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.modifiedAt === right.modifiedAt &&
  left.changedAt === right.changedAt;

const liveBranchSignature = (branch: LiveSessionBranch | undefined): string | null =>
  branch ? `${branch.leafId ?? ""}\0${branch.entries.length}` : null;

const observeSource = (
  file: string,
  branches: MemoryBranches,
  liveBranch: LiveSessionBranch | undefined,
): SourceObservation | null => {
  const identity = sourceIdentity(file);
  if (!identity) return null;
  return {
    file: path.resolve(file),
    identity,
    liveBranchSignature: branches === "active" ? liveBranchSignature(liveBranch) : null,
  };
};

const observeSources = (
  refs: readonly SessionRef[],
  branches: MemoryBranches,
  liveResolver: LiveBranchResolver,
): SourceObservation[] | null => {
  const observations: SourceObservation[] = [];
  for (const ref of refs) {
    const liveBranch = branches === "active" ? liveResolver?.(ref.file) : undefined;
    const observation = observeSource(ref.file, branches, liveBranch);
    if (!observation) return null;
    observations.push(observation);
  }
  return observations;
};

const sameSourceObservation = (left: SourceObservation, right: SourceObservation): boolean =>
  left.file === right.file &&
  sameSourceIdentity(left.identity, right.identity) &&
  left.liveBranchSignature === right.liveBranchSignature;

const sameSourceObservations = (
  left: readonly SourceObservation[],
  right: readonly SourceObservation[],
): boolean => left.length === right.length && left.every((item, index) =>
  sameSourceObservation(item, right[index]!)
);

const recallContinuationKey = (args: MemoryRecallCallArgs): string => JSON.stringify([
  args.query ?? null,
  args.queryMode ?? "literal",
  args.queryMatch ?? null,
  args.expectedSourceHash ?? null,
  args.expectedLineageFingerprint ?? null,
  args.branches ?? "active",
  args.scope ?? "session",
  args.pageSize ?? RECALL_DEFAULT_PAGE_SIZE,
  args.snippetChars ?? RECALL_DEFAULT_SNIPPET_CHARS,
  args.role ?? null,
  args.tool ?? null,
  args.ref ?? null,
  args.provider ?? null,
  args.action ?? null,
  args.outcome ?? null,
  args.since ?? null,
  args.until ?? null,
  args.entryRange ? [args.entryRange.first, args.entryRange.last] : null,
]);

const expansionSnapshotKey = (file: string, branches: MemoryBranches): string =>
  `${path.resolve(file)}\0${branches}`;

const expansionSelectionKey = (selection: CanonicalExpansionSelection): string => JSON.stringify([
  selection.indices ?? null,
  selection.entryIds ?? null,
  selection.operationAddresses ?? null,
  selection.entryRange ? [selection.entryRange.first, selection.entryRange.last] : null,
  selection.before ?? 0,
  selection.after ?? 0,
]);

const errorOutputSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["code", "message"],
};

const coverageOutputSchema = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    indexedSessions: { type: "number" },
    eligibleSessions: { type: "number" },
    staleSessions: { type: "number" },
    incompleteSessions: { type: "number" },
    reasons: {
      type: "array",
      items: { type: "string" },
      description: "Stable machine-readable incompleteness codes; empty when complete is true.",
    },
    error: errorOutputSchema,
  },
  required: [
    "complete",
    "indexedSessions",
    "eligibleSessions",
    "staleSessions",
    "incompleteSessions",
    "reasons",
  ],
};

const callOutputSchema = (ref: "memory.recall" | "memory.expand") => ({
  type: "object",
  properties: {
    ref: { const: ref },
    args: { type: "object" },
  },
  required: ["ref", "args"],
});

const recallEntryOutputSchema = {
  type: "object",
  properties: {
    kind: { const: "entry" },
    sessionId: { type: "string" },
    tier: { type: "string", enum: ["hot", "cold"] },
    index: { type: "number" },
    entryId: { type: ["string", "null"] },
    parentId: { type: ["string", "null"] },
    operationAddress: { type: ["string", "null"] },
    type: { type: "string" },
    role: { type: ["string", "null"] },
    tool: { type: ["string", "null"] },
    ref: { type: ["string", "null"] },
    provider: { type: ["string", "null"] },
    action: { type: ["string", "null"] },
    timestamp: { type: ["number", "null"] },
    isError: { type: "boolean" },
    outcome: { type: "string", enum: ["succeeded", "failed", "aborted", "timed_out"] },
    score: { type: "number" },
    snippet: { type: "string" },
    truncated: { type: "boolean" },
    follow: callOutputSchema("memory.expand"),
  },
  required: [
    "kind",
    "sessionId",
    "tier",
    "index",
    "entryId",
    "parentId",
    "operationAddress",
    "type",
    "role",
    "tool",
    "ref",
    "provider",
    "action",
    "timestamp",
    "isError",
    "score",
    "snippet",
    "truncated",
    "follow",
  ],
};

const recallSessionOutputSchema = {
  type: "object",
  properties: {
    kind: { const: "session" },
    sessionId: { type: "string" },
    tier: { const: "cold" },
    cwd: { type: "string" },
    lastTimestamp: { type: ["number", "null"] },
    score: { type: "number" },
    matchedTerms: { type: "number" },
    matchedStructuralEntries: { type: "number" },
    follow: callOutputSchema("memory.recall"),
  },
  required: [
    "kind",
    "sessionId",
    "tier",
    "cwd",
    "lastTimestamp",
    "score",
    "matchedTerms",
    "matchedStructuralEntries",
    "follow",
  ],
};

const recallOutputSchema: Record<string, unknown> = {
  type: "object",
  description: "Bounded ranked memory hits with uniform follow and pagination calls.",
  properties: {
    total: { type: "number" },
    hits: {
      type: "array",
      description: "Call tools.call(hit.follow) to expand an entry or resolve a cold session.",
      items: { oneOf: [recallEntryOutputSchema, recallSessionOutputSchema] },
    },
    next: {
      oneOf: [callOutputSchema("memory.recall"), { type: "null" }],
      description: "When non-null, call tools.call(next).",
    },
    coverage: coverageOutputSchema,
    error: errorOutputSchema,
  },
  required: ["total", "hits", "next", "coverage"],
};

const expandOutputSchema: Record<string, unknown> = {
  type: "object",
  description: "Integrity-bound session entries returned as lossless bounded text chunks.",
  properties: {
    session: { type: "string" },
    sourceHash: { type: "string" },
    branches: { type: "string", enum: ["active", "all"] },
    lineageFingerprint: { type: "string" },
    entryCount: { type: "number" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          entryId: { type: ["string", "null"] },
          parentId: { type: ["string", "null"] },
          type: { type: ["string", "null"] },
          role: { type: ["string", "null"] },
          timestamp: { type: ["number", "null"] },
          isError: { type: "boolean" },
          text: { type: "string" },
          textRange: {
            type: "object",
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              total: { type: "number" },
              complete: { type: "boolean" },
            },
            required: ["start", "end", "total", "complete"],
          },
          anchor: { type: "boolean" },
          parentEntryId: { type: ["string", "null"] },
          operationAddress: { type: ["string", "null"] },
          tool: { type: ["string", "null"] },
          ref: { type: ["string", "null"] },
          provider: { type: ["string", "null"] },
          action: { type: ["string", "null"] },
          outcome: { type: "string", enum: ["succeeded", "failed", "aborted", "timed_out"] },
          filesTouched: { type: "array", items: { type: ["string", "null"] } },
          operation: { type: "object" },
          branchFact: { type: "object" },
          structuredTruncated: { type: "boolean" },
          factAddress: { type: ["string", "null"] },
          carrierEntryId: { type: ["string", "null"] },
          carrierParentId: { type: ["string", "null"] },
          carrierFromId: { type: ["string", "null"] },
        },
        required: ["index", "entryId", "parentId", "type", "role", "timestamp", "isError", "text", "textRange"],
      },
    },
    next: {
      oneOf: [callOutputSchema("memory.expand"), { type: "null" }],
      description: "When non-null, call tools.call(next).",
    },
    error: errorOutputSchema,
  },
  required: ["entries"],
};

const sessionsOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    scope: { type: "string" },
    branches: { type: "string", enum: ["active", "all"] },
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          cwd: { type: "string" },
          mtime: { type: "number" },
          entryCount: { type: "number" },
          tier: { type: "string", enum: ["hot", "cold"] },
          branches: { type: "string", enum: ["active", "all"] },
          lineageFingerprint: { type: ["string", "null"] },
        },
        required: [
          "id",
          "file",
          "cwd",
          "mtime",
          "entryCount",
          "tier",
          "branches",
          "lineageFingerprint",
        ],
      },
    },
    error: errorOutputSchema,
  },
};

const descriptors: FabricActionDescriptor[] = [
  {
    name: "recall",
    description:
      "Search session memory as bounded ranked snippets. Literal queries rank any matching term by default; queryMatch all narrows to co-located terms. Call tools.call(hit.follow) for either an exact entry or a cold-session candidate, and tools.call(next) to continue.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 4096 },
        queryMode: {
          type: "string",
          enum: ["literal", "phrase", "regex"],
          default: "literal",
          description: "Canonical tokens (default), one case-insensitive exact phrase, or explicitly bounded regex.",
        },
        queryMatch: {
          type: "string",
          enum: ["all", "any"],
          default: "any",
          description: "For literal mode, accept any term (default) or require all terms in one hot entry.",
        },
        expectedSourceHash: {
          type: "string",
          description: "SHA-256 from a prior pointer; stale sources are refused.",
        },
        expectedLineageFingerprint: {
          type: "string",
          description: "Active-lineage fingerprint from a prior pointer; changed leaves are refused.",
        },
        branches: {
          type: "string",
          enum: ["active", "all"],
          description: "Search the active parent-linked path (default) or every branch.",
        },
        scope: {
          type: "string",
          description:
            "session | project | global | session:<id-or-path>. Defaults to session.",
        },
        offset: {
          type: "number",
          minimum: 0,
          description: "Exact ranked-hit offset, normally copied from next.args.",
        },
        pageSize: { type: "number", minimum: 1, maximum: RECALL_MAX_PAGE_SIZE, default: RECALL_DEFAULT_PAGE_SIZE },
        snippetChars: {
          type: "number",
          minimum: 80,
          maximum: RECALL_MAX_SNIPPET_CHARS,
          default: RECALL_DEFAULT_SNIPPET_CHARS,
          description: "Maximum indexed-text characters shown per hit; full text remains in memory.expand.",
        },
        role: {
          type: "string",
          enum: [
            "assistant",
            "bashExecution",
            "branchCustomMessage",
            "branchSummary",
            "branchUser",
            "compaction",
            "compactionSummary",
            "custom",
            "fabricOperation",
            "fabricPhase",
            "fabricRun",
            "toolResult",
            "user",
          ],
          description:
            "Exact normalized entry role to filter by: the closed set the session normalizer can produce.",
        },
        tool: { type: "string" },
        ref: {
          type: "string",
          minLength: 1,
          description: "Exact persisted Fabric action ref, such as omp.grep. This is structural selection, not lexical expansion.",
        },
        provider: {
          type: "string",
          minLength: 1,
          description: "Exact persisted Fabric provider identity.",
        },
        action: {
          type: "string",
          minLength: 1,
          description: "Exact persisted Fabric action name.",
        },
        outcome: {
          type: "string",
          enum: ["succeeded", "failed", "aborted", "timed_out"],
          description: "Exact persisted Fabric execution outcome.",
        },
        since: { type: "number" },
        until: { type: "number" },
        entryRange: {
          type: "object",
          description:
            "Inclusive normalized-entry range for an explicit session:<id> resolution.",
          properties: {
            first: { type: "number", minimum: 0 },
            last: { type: "number", minimum: 0 },
          },
          required: ["first", "last"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    outputSchema: recallOutputSchema,
    risk: "read",
    namespace: "memory",
  },
  {
    name: "expand",
    description:
      "Read exact normalized session entries and nearby context as bounded lossless chunks. Call tools.call(next) to continue, or use guest-side memory.walk(args, visitor) to traverse complete reassembled entries.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Exact session file path or unambiguous id." },
        expectedSourceHash: {
          type: "string",
          description: "SHA-256 from a prior pointer; stale sources are refused.",
        },
        expectedLineageFingerprint: {
          type: "string",
          description: "Active-lineage fingerprint from a prior pointer; changed leaves are refused.",
        },
        branches: {
          type: "string",
          enum: ["active", "all"],
          description: "Expand on the active parent-linked path (default) or across every branch.",
        },
        indices: { type: "array", maxItems: EXPAND_MAX_EXACT_SELECTORS, items: { type: "number", minimum: 0 } },
        entryIds: { type: "array", maxItems: EXPAND_MAX_EXACT_SELECTORS, items: { type: "string", maxLength: 512 } },
        operationAddresses: { type: "array", maxItems: EXPAND_MAX_EXACT_SELECTORS, items: { type: "string", maxLength: 512 } },
        entryRange: {
          type: "object",
          properties: {
            first: { type: "number", minimum: 0 },
            last: { type: "number", minimum: 0 },
          },
          required: ["first", "last"],
          additionalProperties: false,
        },
        before: {
          type: "number",
          minimum: 0,
          maximum: EXPAND_MAX_CONTEXT,
          default: 0,
          description: "Entries before one exact selected anchor.",
        },
        after: {
          type: "number",
          minimum: 0,
          maximum: EXPAND_MAX_CONTEXT,
          default: 0,
          description: "Entries after one exact selected anchor.",
        },
        entryOffset: {
          type: "number",
          minimum: 0,
          description: "Continuation offset within the resolved selection; copy from next.args.",
        },
        textOffset: {
          type: "number",
          minimum: 0,
          description: "Continuation offset within the first returned entry; copy from next.args.",
        },
        maxChars: {
          type: "number",
          minimum: 256,
          maximum: EXPAND_MAX_CHARS,
          default: EXPAND_DEFAULT_MAX_CHARS,
          description: "Total entry-text characters returned in this chunk.",
        },
        maxEntries: {
          type: "number",
          minimum: 1,
          maximum: EXPAND_MAX_ENTRIES,
          default: EXPAND_DEFAULT_MAX_ENTRIES,
          description: "Maximum complete or partial entries returned in this chunk.",
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
    outputSchema: expandOutputSchema,
    risk: "read",
    namespace: "memory",
  },
  {
    name: "sessions",
    description: "List known sessions in scope with id, file, cwd, mtime, entry count, and hot/cold tier.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        branches: {
          type: "string",
          enum: ["active", "all"],
          description: "Count the active parent-linked path (default) or every branch.",
        },
        limit: {
          type: "number",
          minimum: 1,
          description: "Maximum sessions returned; capped at the internal session ceiling.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: sessionsOutputSchema,
    risk: "read",
    namespace: "memory",
  },
];

// Value spellings models reliably substitute for the documented memory scopes,
// e.g. scope "cwd" for "project". Same discipline as the key aliases below:
// identical intent only. Unknown scopes still fall through to resolveScope's
// default "session" handling.
const MEMORY_SCOPE_VALUE_ALIASES: Record<string, string> = {
  cwd: "project",
  repo: "project",
  directory: "project",
  folder: "project",
  all: "global",
  current: "session",
};

const MEMORY_ARG_NORMALIZATION: Record<string, ArgNormalizationSpec> = {
  recall: { values: { scope: MEMORY_SCOPE_VALUE_ALIASES } },
  sessions: { values: { scope: MEMORY_SCOPE_VALUE_ALIASES } },
};

// Argument repair derives from the action schemas plus the shared synonym
// lexicon; only scope value spellings stay table-bound because the schema
// spells scope as a free string rather than an enum.
export const normalizeMemoryArgs = actionArgNormalizer(
  () => descriptors,
  MEMORY_ARG_NORMALIZATION,
);

export interface MemoryProviderContext {
  agentDir: string;
  cwd: string;
  config: FabricMemoryConfig;
  sessionId?: string;
  sessionFile?: string;
  getLiveBranch?: () => LiveSessionBranch;
}

const parseBranches = (value: unknown, action: string): MemoryBranches => {
  if (value === undefined) return "active";
  if (value === "active" || value === "all") return value;
  throw new Error(`${action} branches must be "active" or "all"`);
};

const resolveIndexOptions = (
  config: FabricMemoryConfig,
  agentDir: string,
  branches: MemoryBranches,
  liveBranchForFile?: MemoryIndexOptions["liveBranchForFile"],
): MemoryIndexOptions => ({
  indexDir: config.indexDir ?? `${agentDir}/fabric/memory-index`,
  maxEntryChars: config.maxEntryChars,
  branches,
  indexThinking: config.indexThinking ?? false,
  indexToolOutput: config.indexToolOutput ?? true,
  ...(liveBranchForFile ? { liveBranchForFile } : {}),
  hotSessions: config.hotSessions ?? DEFAULT_HOT_SESSIONS,
  digestTerms: config.digestTerms ?? 200,
  ...(config.maxColdVocabularyBytes === undefined
    ? {} : { maxColdVocabularyBytes: config.maxColdVocabularyBytes }),
  ...(config.maxColdCacheBytes === undefined ? {} : { maxColdCacheBytes: config.maxColdCacheBytes }),
  ...(config.maxSyncSessions === undefined ? {} : { maxSyncSessions: config.maxSyncSessions }),
  ...(config.maxSyncSourceBytes === undefined ? {} : { maxSyncSourceBytes: config.maxSyncSourceBytes }),
  ...(config.maxCacheCleanupFiles === undefined
    ? {} : { maxCacheCleanupFiles: config.maxCacheCleanupFiles }),
});

const resolveTierRefs = (refs: SessionRef[], context: MemoryProviderContext): SessionRef[] => {
  const all = enumerateAllSessions(context.agentDir, Number.MAX_SAFE_INTEGER);
  const known = new Set(all.map((ref) => ref.file));
  for (const ref of refs) {
    if (!known.has(ref.file)) all.push(ref);
  }
  return all;
};

const resolveRefs = (
  scope: string | undefined,
  context: MemoryProviderContext,
  boundedBrowse: boolean,
): SessionRef[] => {
  const effectiveScope = scope ?? "session";
  const input: ResolveScopeInput = {
    agentDir: context.agentDir,
    cwd: context.cwd,
    scope: effectiveScope,
    maxSessions: boundedBrowse ? context.config.maxSessions : Number.MAX_SAFE_INTEGER,
  };
  if (context.sessionId) input.sessionId = context.sessionId;
  if (context.sessionFile) input.sessionFile = context.sessionFile;
  return resolveScope(input);
};

const liveBranchResolver = (
  context: MemoryProviderContext,
): MemoryIndexOptions["liveBranchForFile"] | undefined => {
  if (!context.sessionFile || !context.getLiveBranch) return undefined;
  const current = path.resolve(context.sessionFile);
  return (sessionFile) => path.resolve(sessionFile) === current
    ? context.getLiveBranch?.()
    : undefined;
};

const stalePointerError = (
  sessionFile: string,
  expectedSourceHash: string | undefined,
  actualSourceHash: string,
  expectedLineageFingerprint?: string,
  actualLineageFingerprint?: string,
) => ({
  code: "stale_pointer",
  message: expectedLineageFingerprint !== undefined &&
    expectedLineageFingerprint !== actualLineageFingerprint
    ? "Session active lineage changed after the pointer was issued."
    : "Session source changed after the pointer was issued.",
  sessionFile,
  ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
  actualSourceHash,
  ...(expectedLineageFingerprint === undefined ? {} : { expectedLineageFingerprint }),
  ...(actualLineageFingerprint === undefined ? {} : { actualLineageFingerprint }),
});

const addressError = (message: string, entryCount?: number) => ({
  code: "index_out_of_bounds",
  message,
  ...(entryCount === undefined ? {} : { entryCount }),
});

const recallFailure = (error: { code: string; message: string; [key: string]: unknown }) => ({
  total: 0,
  hits: [],
  next: null,
  coverage: {
    complete: false,
    indexedSessions: 0,
    eligibleSessions: 0,
    staleSessions: 0,
    incompleteSessions: 0,
    reasons: [error.code],
  },
  error,
});

export class MemoryProvider implements FabricProvider {
  readonly name = "memory";
  readonly description =
    "Cross-session memory: a search engine over every OMP session timeline on this machine";

  private recallContinuation: RecallContinuationCache | undefined;
  private readonly expansionSnapshots = new Map<string, ExpansionSnapshot>();

  constructor(private readonly context: MemoryProviderContext) {}

  private cachedRecallContinuation(
    key: string,
    observations: SourceObservation[] | null,
  ): RecallContinuationCache | undefined {
    const cached = this.recallContinuation;
    if (!cached || cached.key !== key) return undefined;
    if (
      !observations ||
      Date.now() - cached.touchedAt > CONTINUATION_CACHE_TTL_MS ||
      !sameSourceObservations(cached.observations, observations)
    ) {
      this.recallContinuation = undefined;
      return undefined;
    }
    cached.touchedAt = Date.now();
    return cached;
  }

  private rememberRecallContinuation(cached: RecallContinuationCache): void {
    this.recallContinuation = cached;
  }

  private forgetRecallContinuation(cached: RecallContinuationCache): void {
    if (this.recallContinuation === cached) this.recallContinuation = undefined;
  }

  private cachedExpansionSnapshot(
    file: string,
    branches: MemoryBranches,
    observation: SourceObservation | null,
  ): ExpansionSnapshot | undefined {
    const key = expansionSnapshotKey(file, branches);
    const cached = this.expansionSnapshots.get(key);
    if (!cached) return undefined;
    if (
      !observation ||
      Date.now() - cached.touchedAt > CONTINUATION_CACHE_TTL_MS ||
      !sameSourceObservation(cached.observation, observation)
    ) {
      this.expansionSnapshots.delete(key);
      return undefined;
    }
    cached.touchedAt = Date.now();
    this.expansionSnapshots.delete(key);
    this.expansionSnapshots.set(key, cached);
    return cached;
  }

  private rememberExpansionSnapshot(snapshot: ExpansionSnapshot): void {
    const key = expansionSnapshotKey(snapshot.file, snapshot.branches);
    this.expansionSnapshots.delete(key);
    this.expansionSnapshots.set(key, snapshot);
    while (this.expansionSnapshots.size > EXPANSION_SNAPSHOT_LIMIT) {
      const oldest = this.expansionSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.expansionSnapshots.delete(oldest);
    }
  }

  private rememberExpansionSelection(
    snapshot: ExpansionSnapshot,
    keys: readonly string[],
    selection: ResolvedExpansionSelection,
  ): void {
    for (const key of new Set(keys)) {
      snapshot.selections.delete(key);
      snapshot.selections.set(key, selection);
    }
    while (snapshot.selections.size > EXPANSION_SELECTION_LIMIT) {
      const oldest = snapshot.selections.keys().next().value;
      if (oldest === undefined) break;
      snapshot.selections.delete(oldest);
    }
  }

  private forgetExpansionSnapshot(snapshot: ExpansionSnapshot): void {
    const key = expansionSnapshotKey(snapshot.file, snapshot.branches);
    if (this.expansionSnapshots.get(key) === snapshot) this.expansionSnapshots.delete(key);
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(
    actionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    return normalizeMemoryArgs(actionName, args);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    invocationContext: FabricInvocationContext,
  ): Promise<unknown> {
    try {
      switch (actionName) {
        case "recall":
          return await this.recall(args, invocationContext);
        case "expand":
          return await this.expand(args);
        case "sessions":
          return await this.sessions(args);
        default:
          throw new Error(`Unknown memory action: ${actionName}`);
      }
    } catch (error) {
      if (error instanceof AmbiguousSessionError) {
        const detail = {
          code: error.code,
          message: error.message,
          session: error.session,
          candidates: error.candidates,
        };
        if (actionName === "recall") return recallFailure(detail);
        if (actionName === "expand") return { entries: [], next: null, error: detail };
        return { error: detail };
      }
      throw error;
    }
  }

  private async recall(
    args: Record<string, unknown>,
    invocationContext: FabricInvocationContext,
  ): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query : undefined;
    const rawQueryMode = args.queryMode;
    if (
      rawQueryMode !== undefined &&
      rawQueryMode !== "literal" &&
      rawQueryMode !== "phrase" &&
      rawQueryMode !== "regex"
    ) {
      throw new Error('memory.recall queryMode must be "literal", "phrase", or "regex"');
    }
    const queryMode: MemoryQueryMode = rawQueryMode === "phrase"
      ? "phrase"
      : rawQueryMode === "regex"
        ? "regex"
        : "literal";
    const rawQueryMatch = args.queryMatch;
    if (rawQueryMatch !== undefined && rawQueryMatch !== "all" && rawQueryMatch !== "any") {
      throw new Error('memory.recall queryMatch must be "all" or "any"');
    }
    if (queryMode !== "literal" && rawQueryMatch !== undefined) {
      throw new Error("memory.recall queryMatch is only valid with literal queryMode");
    }
    const queryMatch: MemoryQueryMatch = rawQueryMatch === "all" ? "all" : "any";
    const expectedSourceHash = typeof args.expectedSourceHash === "string"
      ? args.expectedSourceHash
      : undefined;
    const expectedLineageFingerprint = typeof args.expectedLineageFingerprint === "string"
      ? args.expectedLineageFingerprint
      : undefined;
    const branches = parseBranches(args.branches, "memory.recall");
    const scope = typeof args.scope === "string" ? args.scope : undefined;
    const role = typeof args.role === "string" ? args.role : undefined;
    const tool = typeof args.tool === "string" ? args.tool : undefined;
    const ref = typeof args.ref === "string" ? args.ref : undefined;
    const provider = typeof args.provider === "string" ? args.provider : undefined;
    const action = typeof args.action === "string" ? args.action : undefined;
    const rawOutcome = args.outcome;
    if (
      rawOutcome !== undefined &&
      rawOutcome !== "succeeded" &&
      rawOutcome !== "failed" &&
      rawOutcome !== "aborted" &&
      rawOutcome !== "timed_out"
    ) {
      throw new Error("memory.recall outcome must be succeeded, failed, aborted, or timed_out");
    }
    const outcome = rawOutcome as SearchFilters["outcome"];
    const since = typeof args.since === "number" ? args.since : undefined;
    const until = typeof args.until === "number" ? args.until : undefined;
    const offset = typeof args.offset === "number" && args.offset >= 0
      ? Math.floor(args.offset)
      : undefined;
    const pageSize =
      typeof args.pageSize === "number" && args.pageSize >= 1
        ? Math.min(Math.floor(args.pageSize), RECALL_MAX_PAGE_SIZE)
        : RECALL_DEFAULT_PAGE_SIZE;
    const snippetChars =
      typeof args.snippetChars === "number" && args.snippetChars >= 80
        ? Math.min(Math.floor(args.snippetChars), RECALL_MAX_SNIPPET_CHARS)
        : RECALL_DEFAULT_SNIPPET_CHARS;

    const refs = resolveRefs(scope, this.context, false);
    const liveResolver = liveBranchResolver(this.context);
    const options = resolveIndexOptions(
      this.context.config,
      this.context.agentDir,
      branches,
      liveResolver,
    );
    const hydrate = scope?.trim().startsWith("session:") ?? false;
    if ((expectedSourceHash !== undefined || expectedLineageFingerprint !== undefined) && !hydrate) {
      throw new Error("memory.recall integrity expectations require scope session:<id-or-path>");
    }

    const rawRange = args.entryRange;
    const entryRange = rawRange && typeof rawRange === "object" && !Array.isArray(rawRange)
      ? rawRange as Record<string, unknown>
      : undefined;
    const first = entryRange?.first;
    const last = entryRange?.last;
    if ((first === undefined) !== (last === undefined)) {
      throw new Error("memory.recall entryRange requires both first and last");
    }
    if ((first !== undefined || last !== undefined) && !hydrate) {
      throw new Error("memory.recall entryRange requires scope session:<id-or-path>");
    }
    if (first !== undefined && (
      typeof first !== "number" ||
      typeof last !== "number" ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 0 ||
      last < first
    )) {
      return recallFailure(addressError("Entry range requires safe integers with 0 <= first <= last."));
    }
    const selectedRange: EntryRange | undefined =
      typeof first === "number" && typeof last === "number" ? { first, last } : undefined;
    const filters: SearchFilters = {};
    if (role) filters.role = role;
    if (tool) filters.tool = tool;
    if (ref) filters.ref = ref;
    if (provider) filters.provider = provider;
    if (action) filters.action = action;
    if (outcome) filters.outcome = outcome;
    if (since !== undefined) filters.since = since;
    if (until !== undefined) filters.until = until;
    const baseRequestArgs: MemoryRecallCallArgs = {
      ...(query === undefined ? {} : { query }),
      queryMode,
      ...(queryMode === "literal" ? { queryMatch } : {}),
      ...(expectedSourceHash ? { expectedSourceHash } : {}),
      ...(expectedLineageFingerprint ? { expectedLineageFingerprint } : {}),
      branches,
      scope: scope ?? "session",
      ...(offset === undefined ? {} : { offset }),
      pageSize,
      snippetChars,
      ...(role ? { role } : {}),
      ...(tool ? { tool } : {}),
      ...(ref ? { ref } : {}),
      ...(provider ? { provider } : {}),
      ...(action ? { action } : {}),
      ...(outcome ? { outcome } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(selectedRange ? { entryRange: selectedRange } : {}),
    };
    const updateProgress = (searchResult: SearchResult): void => {
      invocationContext.update(
        searchResult.matchMode === "structural"
          ? `memory.recall: ${searchResult.matchedCount} structural matches`
          : searchResult.matchMode === "combined"
            ? `memory.recall: ${searchResult.matchedCount} filtered matches`
            : query
              ? `memory.recall: ${searchResult.matchedCount} matches`
              : `memory.recall: ${searchResult.matchedCount} recent entries`,
      );
    };
    const observationsBefore = observeSources(refs, branches, liveResolver);
    const cached = offset === undefined
      ? undefined
      : this.cachedRecallContinuation(
          recallContinuationKey(baseRequestArgs),
          observationsBefore,
        );
    if (cached) {
      const response = presentRecall({
        result: cached.result,
        ...(query === undefined ? {} : { query }),
        queryMode,
        coverage: cached.coverage,
        ...(offset === undefined ? {} : { offset }),
        pageSize,
        snippetChars,
        requestArgs: cached.requestArgs,
      });
      const observationsAfterCachedPage = observeSources(refs, branches, liveResolver);
      if (
        observationsBefore &&
        observationsAfterCachedPage &&
        sameSourceObservations(observationsBefore, observationsAfterCachedPage)
      ) {
        if (response.next === null) this.forgetRecallContinuation(cached);
        updateProgress(cached.result);
        return response;
      }
      this.forgetRecallContinuation(cached);
    }

    if (hydrate && refs[0]) {
      const state = fingerprintSource(refs[0].file);
      const lineage = reconstructSessionLineage(
        refs[0].file,
        branches,
        liveResolver?.(refs[0].file),
      );
      const sourceChanged = expectedSourceHash !== undefined &&
        state?.sourceHash !== expectedSourceHash;
      const lineageChanged = expectedLineageFingerprint !== undefined &&
        lineage.fingerprint !== expectedLineageFingerprint;
      if (state && (sourceChanged || lineageChanged)) {
        return recallFailure(stalePointerError(
          refs[0].file,
          expectedSourceHash,
          state.sourceHash,
          expectedLineageFingerprint,
          lineage.fingerprint,
        ));
      }
    }

    const index = loadTieredIndex(
      refs,
      resolveTierRefs(refs, this.context),
      options,
      hydrate,
      selectedRange,
    );
    const hydratedShard = index.shards[0];
    const hydratedSourceChanged = expectedSourceHash !== undefined &&
      hydratedShard?.sourceHash !== expectedSourceHash;
    const hydratedLineageChanged = expectedLineageFingerprint !== undefined &&
      hydratedShard?.lineageFingerprint !== expectedLineageFingerprint;
    if (hydrate && hydratedShard && (hydratedSourceChanged || hydratedLineageChanged)) {
      return recallFailure(stalePointerError(
        hydratedShard.sessionFile,
        expectedSourceHash,
        hydratedShard.sourceHash,
        expectedLineageFingerprint,
        hydratedShard.lineageFingerprint,
      ));
    }
    if (
      hydrate &&
      selectedRange &&
      index.shards[0] &&
      selectedRange.last >= index.shards[0].totalEntryCount
    ) {
      return recallFailure(addressError(
        `Entry range ends at ${selectedRange.last}, but the session has ${index.shards[0].totalEntryCount} entries.`,
        index.shards[0].totalEntryCount,
      ));
    }

    const searchQuery = {
      ...(query === undefined ? {} : { query }),
      queryMode,
      queryMatch,
      filters,
      regexLimits: {
        maxPatternBytes: this.context.config.regexMaxPatternBytes
          ?? DEFAULT_REGEX_MAX_PATTERN_BYTES,
        maxHaystackTerms: this.context.config.regexMaxHaystackTerms
          ?? DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
        maxHaystackBytes: this.context.config.regexMaxHaystackBytes
          ?? DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
        timeoutMs: this.context.config.regexTimeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS,
      },
    };
    const result = await searchMemoryIndex(index.shards, index.digests, searchQuery);
    const coverage = {
      ...index.coverage,
      complete: index.coverage.complete && result.queryCoverage.complete,
      reasons: [...new Set([...index.coverage.reasons, ...result.queryCoverage.reasons])].sort(),
      ...(result.queryCoverage.error ? { error: result.queryCoverage.error } : {}),
    };
    const soleRef = refs.length === 1 ? refs[0] : undefined;
    const soleShard = soleRef
      ? index.shards.find((candidate) => candidate.sessionFile === soleRef.file)
      : undefined;
    const soleDigest = soleRef
      ? index.digests.find((candidate) => candidate.file === soleRef.file)
      : undefined;
    const continuationBinding = soleRef && (soleShard?.sourceHash || soleDigest?.sourceHash)
      ? {
          file: soleRef.file,
          sourceHash: soleShard?.sourceHash ?? soleDigest!.sourceHash,
          lineageFingerprint: soleShard?.lineageFingerprint ?? soleDigest!.lineageFingerprint,
        }
      : undefined;
    const requestArgs: MemoryRecallCallArgs = {
      ...baseRequestArgs,
      ...((expectedSourceHash ?? continuationBinding?.sourceHash)
        ? { expectedSourceHash: expectedSourceHash ?? continuationBinding!.sourceHash }
        : {}),
      ...((expectedLineageFingerprint ?? continuationBinding?.lineageFingerprint)
        ? {
            expectedLineageFingerprint:
              expectedLineageFingerprint ?? continuationBinding!.lineageFingerprint,
          }
        : {}),
      scope: continuationBinding
        ? `session:${continuationBinding.file}`
        : baseRequestArgs.scope ?? "session",
    };
    const response = presentRecall({
      result,
      ...(query === undefined ? {} : { query }),
      queryMode,
      coverage,
      ...(offset === undefined ? {} : { offset }),
      pageSize,
      snippetChars,
      requestArgs,
    });
    const observationsAfter = observeSources(refs, branches, liveResolver);
    if (
      response.next !== null &&
      observationsBefore &&
      observationsAfter &&
      sameSourceObservations(observationsBefore, observationsAfter)
    ) {
      this.rememberRecallContinuation({
        key: recallContinuationKey(requestArgs),
        result,
        coverage,
        requestArgs,
        observations: observationsAfter,
        touchedAt: Date.now(),
      });
    }
    updateProgress(result);
    return response;
  }

  private async expand(args: Record<string, unknown>): Promise<unknown> {
    const session = typeof args.session === "string" ? args.session : "";
    const expectedSourceHash = typeof args.expectedSourceHash === "string"
      ? args.expectedSourceHash
      : undefined;
    const expectedLineageFingerprint = typeof args.expectedLineageFingerprint === "string"
      ? args.expectedLineageFingerprint
      : undefined;
    const branches = parseBranches(args.branches, "memory.expand");
    const rawIndices = args.indices;
    if (rawIndices !== undefined && !Array.isArray(rawIndices)) {
      throw new Error("memory.expand indices must be an array");
    }
    if (Array.isArray(rawIndices) && !rawIndices.every((index) =>
      typeof index === "number" && Number.isSafeInteger(index) && index >= 0)) {
      return { session, error: addressError("Every entry index must be a non-negative safe integer."), entries: [] };
    }
    const indices = (rawIndices as number[] | undefined) ?? [];
    const entryIds = Array.isArray(args.entryIds)
      ? args.entryIds.filter(
          (entryId): entryId is string => typeof entryId === "string" && entryId.length > 0,
        )
      : [];
    const operationAddresses = Array.isArray(args.operationAddresses)
      ? args.operationAddresses.filter(
          (address): address is string => typeof address === "string" && address.length > 0,
        )
      : [];
    if (indices.length + entryIds.length + operationAddresses.length > EXPAND_MAX_EXACT_SELECTORS) {
      throw new Error(`memory.expand accepts at most ${EXPAND_MAX_EXACT_SELECTORS} exact selectors per call`);
    }
    const rawRange = args.entryRange;
    const rangeRecord = rawRange && typeof rawRange === "object" && !Array.isArray(rawRange)
      ? rawRange as Record<string, unknown>
      : undefined;
    const first = rangeRecord?.first;
    const last = rangeRecord?.last;
    if (!session) throw new Error("memory.expand requires a session");
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
      return { session, error: addressError("Entry range requires safe integers with 0 <= first <= last."), entries: [] };
    }
    const numeric = (value: unknown, fallback: number, maximum: number): number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? Math.min(value, maximum)
        : fallback;
    const before = numeric(args.before, 0, EXPAND_MAX_CONTEXT);
    const after = numeric(args.after, 0, EXPAND_MAX_CONTEXT);
    const entryOffset = numeric(args.entryOffset, 0, Number.MAX_SAFE_INTEGER);
    const textOffset = numeric(args.textOffset, 0, Number.MAX_SAFE_INTEGER);
    const maxChars = Math.max(256, numeric(args.maxChars, EXPAND_DEFAULT_MAX_CHARS, EXPAND_MAX_CHARS));
    const maxEntries = Math.max(1, numeric(args.maxEntries, EXPAND_DEFAULT_MAX_ENTRIES, EXPAND_MAX_ENTRIES));

    const ref = resolveSessionTarget(this.context.agentDir, session);
    if (!ref) {
      return {
        session,
        error: { code: "session_not_found", message: `Session not found: ${session}` },
        entries: [],
      };
    }
    const liveResolver = liveBranchResolver(this.context);
    const observedLiveBranch = branches === "active" ? liveResolver?.(ref.file) : undefined;
    const observedSource = observeSource(ref.file, branches, observedLiveBranch);
    let snapshot = this.cachedExpansionSnapshot(ref.file, branches, observedSource);
    if (snapshot) {
      const sourceChanged = expectedSourceHash !== undefined &&
        snapshot.sourceHash !== expectedSourceHash;
      const lineageChanged = expectedLineageFingerprint !== undefined &&
        snapshot.lineageFingerprint !== expectedLineageFingerprint;
      if (sourceChanged || lineageChanged) {
        return {
          session: ref.file,
          branches,
          error: stalePointerError(
            ref.file,
            expectedSourceHash,
            snapshot.sourceHash,
            expectedLineageFingerprint,
            snapshot.lineageFingerprint,
          ),
          entries: [],
        };
      }
    }

    if (!snapshot) {
      const initialState = fingerprintSource(ref.file);
      if (!initialState) {
        return {
          session: ref.file,
          error: { code: "source_unavailable", message: `Session source is unavailable: ${ref.file}` },
          entries: [],
        };
      }
      const initialLiveBranch = branches === "active" ? liveResolver?.(ref.file) : undefined;
      const initialLineage = reconstructSessionLineage(
        ref.file,
        branches,
        initialLiveBranch,
      );
      const sourceChanged = expectedSourceHash !== undefined &&
        initialState.sourceHash !== expectedSourceHash;
      const lineageChanged = expectedLineageFingerprint !== undefined &&
        initialLineage.fingerprint !== expectedLineageFingerprint;
      if (sourceChanged || lineageChanged) {
        return {
          session: ref.file,
          branches,
          error: stalePointerError(
            ref.file,
            expectedSourceHash,
            initialState.sourceHash,
            expectedLineageFingerprint,
            initialLineage.fingerprint,
          ),
          entries: [],
        };
      }

      const normalized = normalizeSession(
        ref.file,
        Number.MAX_SAFE_INTEGER,
        {
          lineage: initialLineage,
          indexThinking: true,
          indexToolOutput: true,
        },
      ).entries;
      const finalState = fingerprintSource(ref.file);
      const finalLiveBranch = branches === "active" ? liveResolver?.(ref.file) : undefined;
      const finalLineage = reconstructSessionLineage(
        ref.file,
        branches,
        finalLiveBranch,
      );
      const finalObservation = observeSource(ref.file, branches, finalLiveBranch);
      if (
        !finalState ||
        !finalObservation ||
        finalState.sourceHash !== initialState.sourceHash ||
        finalLineage.fingerprint !== initialLineage.fingerprint
      ) {
        return {
          session: ref.file,
          error: stalePointerError(
            ref.file,
            expectedSourceHash ?? initialState.sourceHash,
            finalState?.sourceHash ?? "",
            expectedLineageFingerprint ?? initialLineage.fingerprint,
            finalLineage.fingerprint,
          ),
          entries: [],
        };
      }
      snapshot = {
        file: ref.file,
        branches,
        sourceHash: finalState.sourceHash,
        lineageFingerprint: finalLineage.fingerprint,
        observation: finalObservation,
        entries: normalized,
        selections: new Map(),
        touchedAt: Date.now(),
      };
    }

    const entryCount = snapshot.entries.length;
    const outOfBounds = indices.find((index) => index >= entryCount);
    if (outOfBounds !== undefined) {
      return {
        session: ref.file,
        error: addressError(`Entry index ${outOfBounds} is outside 0..${Math.max(0, entryCount - 1)}.`, entryCount),
        entries: [],
      };
    }
    if (typeof last === "number" && last >= entryCount) {
      return {
        session: ref.file,
        error: addressError(`Entry range ends at ${last}, but the session has ${entryCount} entries.`, entryCount),
        entries: [],
      };
    }
    if (
      indices.length === 0 &&
      entryIds.length === 0 &&
      operationAddresses.length === 0 &&
      (first === undefined || last === undefined)
    ) {
      if (before > 0 || after > 0) {
        throw new Error("memory.expand before/after requires one selected anchor");
      }
      this.forgetExpansionSnapshot(snapshot);
      return {
        session: ref.file,
        sourceHash: snapshot.sourceHash,
        branches,
        lineageFingerprint: snapshot.lineageFingerprint,
        entryCount,
        entries: [],
        next: null,
      };
    }

    const requestedSelection: ExpandSessionSelection = {};
    if (indices.length > 0) requestedSelection.indices = indices;
    if (entryIds.length > 0) requestedSelection.entryIds = entryIds;
    if (operationAddresses.length > 0) requestedSelection.operationAddresses = operationAddresses;
    if (typeof first === "number" && typeof last === "number") {
      requestedSelection.entryRange = { first, last };
    }
    const requestedWithContext: CanonicalExpansionSelection = {
      ...requestedSelection,
      ...(before > 0 ? { before } : {}),
      ...(after > 0 ? { after } : {}),
    };
    const requestedKey = expansionSelectionKey(requestedWithContext);
    let resolved = snapshot.selections.get(requestedKey);
    if (!resolved) {
      let expansion = expandSessionEntriesChecked(snapshot.entries, requestedSelection);
      if ("error" in expansion) {
        return {
          session: ref.file,
          sourceHash: snapshot.sourceHash,
          branches,
          lineageFingerprint: snapshot.lineageFingerprint,
          error: expansion.error,
          entries: [],
        };
      }

      let anchorIndex: number | null = null;
      let canonical: CanonicalExpansionSelection;
      if (before > 0 || after > 0) {
        if (expansion.expanded.length !== 1) {
          throw new Error("memory.expand before/after requires exactly one resolved anchor");
        }
        anchorIndex = expansion.expanded[0]!.index;
        const contextRange = {
          first: Math.max(0, anchorIndex - before),
          last: Math.min(Math.max(0, entryCount - 1), anchorIndex + after),
        };
        canonical = requestedWithContext;
        expansion = expandSessionEntriesChecked(snapshot.entries, { entryRange: contextRange });
        if ("error" in expansion) {
          return {
            session: ref.file,
            sourceHash: snapshot.sourceHash,
            branches,
            lineageFingerprint: snapshot.lineageFingerprint,
            error: expansion.error,
            entries: [],
          };
        }
      } else if (requestedSelection.entryRange) {
        canonical = { entryRange: requestedSelection.entryRange };
      } else {
        canonical = { indices: expansion.expanded.map((entry) => entry.index) };
      }
      resolved = { entries: expansion.expanded, canonical, anchorIndex };
      this.rememberExpansionSelection(
        snapshot,
        [requestedKey, expansionSelectionKey(canonical)],
        resolved,
      );
    }

    const selected = resolved.entries;
    const canonicalSelection = resolved.canonical;
    const anchorIndex = resolved.anchorIndex;
    const finalState = snapshot;
    const finalLineage = { fingerprint: snapshot.lineageFingerprint };
    if (entryOffset > selected.length) {
      return {
        session: ref.file,
        error: addressError(`Entry offset ${entryOffset} is outside 0..${selected.length}.`, selected.length),
        entries: [],
      };
    }
    if (entryOffset < selected.length && textOffset > selected[entryOffset]!.text.length) {
      return {
        session: ref.file,
        error: {
          code: "text_offset_out_of_bounds",
          message: `Text offset ${textOffset} exceeds entry #${selected[entryOffset]!.index} length ${selected[entryOffset]!.text.length}.`,
          textLength: selected[entryOffset]!.text.length,
        },
        entries: [],
      };
    }

    const bounded = (value: string | null, maximum = 512): string | null =>
      value === null || value.length <= maximum
        ? value
        : `${value.slice(0, Math.max(1, maximum - 1))}…`;
    const compactStructure = (value: unknown): unknown => {
      if (value === undefined) return undefined;
      const serialized = JSON.stringify(value);
      return serialized.length <= 2_000 ? value : undefined;
    };
    const output: Array<Record<string, unknown>> = [];
    const cursors: Array<{ position: number; textOffset: number }> = [];
    let position = entryOffset;
    let currentTextOffset = textOffset;
    let remainingChars = maxChars;
    while (position < selected.length && output.length < maxEntries && remainingChars > 0) {
      const entry = selected[position]!;
      let end = Math.min(entry.text.length, currentTextOffset + remainingChars);
      if (
        end < entry.text.length &&
        end > currentTextOffset &&
        entry.text.charCodeAt(end) >= 0xdc00 &&
        entry.text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1;
      }
      if (end === currentTextOffset && currentTextOffset < entry.text.length) {
        end = Math.min(entry.text.length, currentTextOffset + 2);
      }
      const chunk = entry.text.slice(currentTextOffset, end);
      const textComplete = end >= entry.text.length;
      const operation = compactStructure(entry.operation);
      const branchFact = compactStructure(entry.branchFact);
      output.push({
        index: entry.index,
        entryId: bounded(entry.entryId),
        parentId: bounded(entry.parentId),
        type: bounded(entry.type),
        role: bounded(entry.role),
        timestamp: entry.timestamp,
        isError: entry.isError,
        ...(anchorIndex !== null ? { anchor: entry.index === anchorIndex } : {}),
        text: chunk,
        textRange: {
          start: currentTextOffset,
          end,
          total: entry.text.length,
          complete: textComplete,
        },
        ...(entry.parentEntryId !== undefined ? { parentEntryId: bounded(entry.parentEntryId) } : {}),
        ...(entry.operationAddress ? { operationAddress: bounded(entry.operationAddress) } : {}),
        ...(entry.toolName ? { tool: bounded(entry.toolName) } : {}),
        ...(entry.ref ? { ref: bounded(entry.ref) } : {}),
        ...(entry.provider ? { provider: bounded(entry.provider) } : {}),
        ...(entry.action ? { action: bounded(entry.action) } : {}),
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
        ...(entry.filesTouched
          ? { filesTouched: entry.filesTouched.slice(0, 20).map((file) => bounded(file, 1_024)) }
          : {}),
        ...(operation !== undefined ? { operation } : {}),
        ...(branchFact !== undefined ? { branchFact } : {}),
        ...((entry.operation !== undefined && operation === undefined) ||
            (entry.branchFact !== undefined && branchFact === undefined)
          ? { structuredTruncated: true }
          : {}),
        ...(entry.factAddress ? { factAddress: bounded(entry.factAddress) } : {}),
        ...(entry.carrierEntryId ? { carrierEntryId: bounded(entry.carrierEntryId) } : {}),
        ...(entry.carrierParentId !== undefined ? { carrierParentId: bounded(entry.carrierParentId) } : {}),
        ...(entry.carrierFromId !== undefined ? { carrierFromId: bounded(entry.carrierFromId) } : {}),
      });
      remainingChars -= chunk.length;
      if (!textComplete) {
        currentTextOffset = end;
        cursors.push({ position, textOffset: currentTextOffset });
        break;
      }
      position += 1;
      currentTextOffset = 0;
      cursors.push({ position, textOffset: 0 });
    }

    const responseAt = (
      records: Array<Record<string, unknown>>,
      cursor: { position: number; textOffset: number },
    ): Record<string, unknown> => {
      const hasNext = cursor.position < selected.length;
      const nextArgs = hasNext
        ? {
            session: ref.file,
            expectedSourceHash: finalState.sourceHash,
            expectedLineageFingerprint: finalLineage.fingerprint,
            branches,
            ...canonicalSelection,
            entryOffset: cursor.position,
            ...(cursor.textOffset > 0 ? { textOffset: cursor.textOffset } : {}),
            maxChars,
            maxEntries,
          }
        : null;
      return {
        session: ref.file,
        sourceHash: finalState.sourceHash,
        branches,
        lineageFingerprint: finalLineage.fingerprint,
        entryCount,
        entries: records,
        next: nextArgs ? { ref: "memory.expand", args: nextArgs } : null,
      };
    };

    let cursor = { position, textOffset: currentTextOffset };
    let response = responseAt(output, cursor);
    while (output.length > 1 && JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
      output.pop();
      cursors.pop();
      cursor = cursors.at(-1) ?? { position: entryOffset, textOffset };
      response = responseAt(output, cursor);
    }
    if (output.length === 1 && JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
      const record = output[0]!;
      const range = record.textRange as { start: number; end: number; total: number; complete: boolean };
      const chunk = record.text as string;
      const excess = JSON.stringify(response).length - RECALL_MAX_RESPONSE_CHARS;
      let keep = Math.max(1, chunk.length - excess - 256);
      if (
        keep < chunk.length &&
        keep > 0 &&
        chunk.charCodeAt(keep) >= 0xdc00 &&
        chunk.charCodeAt(keep) <= 0xdfff
      ) {
        keep -= 1;
      }
      if (keep > 0 && keep < chunk.length) {
        record.text = chunk.slice(0, keep);
        range.end = range.start + keep;
        range.complete = false;
        cursor = { position: entryOffset, textOffset: range.end };
        response = responseAt(output, cursor);
      }
      if (JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
        delete record.operation;
        delete record.branchFact;
        if (Array.isArray(record.filesTouched)) {
          record.filesTouched = record.filesTouched.slice(0, 4).map((file) => bounded(String(file), 256));
        }
        record.structuredTruncated = true;
        response = responseAt(output, cursor);
      }
      if (JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
        const current = String(record.text);
        const firstCodePointChars = (current.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
        const minimalText = current.slice(0, Math.min(current.length, firstCodePointChars));
        const minimalRange = record.textRange as { start: number; end: number; total: number; complete: boolean };
        minimalRange.end = minimalRange.start + minimalText.length;
        minimalRange.complete = minimalRange.end >= minimalRange.total;
        output[0] = {
          index: record.index,
          entryId: record.entryId,
          parentId: record.parentId,
          type: record.type,
          role: record.role,
          timestamp: record.timestamp,
          isError: record.isError,
          ...(record.anchor !== undefined ? { anchor: record.anchor } : {}),
          text: minimalText,
          textRange: minimalRange,
          structuredTruncated: true,
        };
        cursor = minimalRange.complete
          ? { position: entryOffset + 1, textOffset: 0 }
          : { position: entryOffset, textOffset: minimalRange.end };
        response = responseAt(output, cursor);
      }
    }

    const endingLiveBranch = branches === "active" ? liveResolver?.(ref.file) : undefined;
    const endingObservation = observeSource(ref.file, branches, endingLiveBranch);
    if (!endingObservation || !sameSourceObservation(snapshot.observation, endingObservation)) {
      this.forgetExpansionSnapshot(snapshot);
      const actualState = fingerprintSource(ref.file);
      const actualLineage = reconstructSessionLineage(ref.file, branches, endingLiveBranch);
      if (
        !actualState ||
        !endingObservation ||
        actualState.sourceHash !== snapshot.sourceHash ||
        actualLineage.fingerprint !== snapshot.lineageFingerprint
      ) {
        return {
          session: ref.file,
          error: stalePointerError(
            ref.file,
            expectedSourceHash ?? snapshot.sourceHash,
            actualState?.sourceHash ?? "",
            expectedLineageFingerprint ?? snapshot.lineageFingerprint,
            actualLineage.fingerprint,
          ),
          entries: [],
        };
      }
      snapshot.observation = endingObservation;
    }
    if (response.next === null) {
      this.forgetExpansionSnapshot(snapshot);
    } else {
      snapshot.touchedAt = Date.now();
      this.rememberExpansionSnapshot(snapshot);
    }
    return response;
  }

  private async sessions(args: Record<string, unknown>): Promise<unknown> {
    const scope = typeof args.scope === "string" ? args.scope : undefined;
    const branches = parseBranches(args.branches, "memory.sessions");
    const limit =
      typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1
        ? Math.min(args.limit, SESSIONS_MAX)
        : SESSIONS_MAX;
    const refs = resolveRefs(scope, this.context, true).slice(0, limit);
    const options = resolveIndexOptions(
      this.context.config,
      this.context.agentDir,
      branches,
      liveBranchResolver(this.context),
    );
    const index = loadTieredIndex(refs, resolveTierRefs(refs, this.context), options);
    const shards = new Map(index.shards.map((shard) => [shard.sessionFile, shard]));
    const digests = new Map(index.digests.map((digest) => [digest.file, digest]));
    const sessions = refs.map((ref) => {
      const tier = index.tiers.get(ref.file) ?? "cold";
      const shard = shards.get(ref.file);
      const digest = digests.get(ref.file);
      return {
        id: shard?.sessionId ?? digest?.sessionId ?? ref.id,
        file: ref.file,
        cwd: digest?.cwd ?? ref.cwd,
        mtime: ref.mtime,
        entryCount: shard?.entries.length ?? digest?.entryCount ?? 0,
        tier,
        branches,
        lineageFingerprint: shard?.lineageFingerprint ?? digest?.lineageFingerprint ?? null,
      };
    });
    return { scope: scope ?? "session", branches, sessions };
  }
}
