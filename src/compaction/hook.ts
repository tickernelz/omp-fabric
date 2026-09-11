import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "../core/token-math.js";
import { buildSessionContext, sessionEntryToContextMessages } from "../core/session-context.js";
import { clipUtf8, MAX_SUMMARY_BYTES } from "./bounds.js";
import { modelCompactionKey } from "./threshold.js";
import { NO_BUILTIN_ENRICHERS, runEnrichers, type CompactionEnricher } from "./enrichers.js";
import { compileLcmBranchSummary } from "./branch-summary.js";
import {
  decodeCompactionInstructions,
  type CompactionInstructionDecodeError,
  type CompactionInstructionPolicy,
} from "./instructions.js";
import { countErasedThinkingBlocks, isOmpCustomMessageEntry, normalizeEntries } from "./normalize.js";
import {
  projectWithMetadata,
  type ProjectionOmittedCounts,
  type Sections,
} from "./projections.js";
import { renderSummary } from "./render.js";

type CompactionEngine = "omp" | "lcm";

interface LiveEntry {
  entry: SessionEntry;
  branchIndex: number;
  turnBoundary: boolean;
  cutPoint: boolean;
  estimatedTokens: number;
  message?: {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
  };
}

interface CallResultSpan {
  first: number;
  last: number;
  hasCall: boolean;
  hasResult: boolean;
}

export interface FabricCompactionBudget {
  contextWindow: number;
  targetContextRatio: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

type FabricCompactionBindingConstraint =
  | "continuity"
  | "occupancy"
  | "reserve"
  | "reduction";

export interface FabricCompactionBudgetDetails {
  strategy: "adaptive" | "continuity";
  contextWindow: number;
  targetContextRatio: number;
  targetContextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  rawTokensBefore: number;
  tokenScale: number;
  fixedOverheadTokens: number;
  retainedRawTokens: number;
  projectedTokensAfter: number;
  continuityTargetTokens?: number;
  occupancyCeilingTokens?: number;
  safeCeilingTokens?: number;
  reductionCeilingTokens?: number;
  rawTailTokenBudget?: number;
  bindingConstraint?: FabricCompactionBindingConstraint;
}

interface ContinuityCutPlan {
  contextWindow: number;
  targetContextRatio: number;
  targetContextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  rawTokensBefore: number;
  tokenScale: number;
  fixedOverheadTokens: number;
  continuityTargetTokens: number;
  occupancyCeilingTokens: number;
  safeCeilingTokens: number;
  reductionCeilingTokens: number;
  rawTailTokenBudget: number;
  bindingConstraint: FabricCompactionBindingConstraint;
}

const SUMMARY_RAW_TOKEN_BUDGET = Math.ceil(MAX_SUMMARY_BYTES / 4);
const HARD_CEILING_SAFETY_RATIO = 0.9;
const MAX_PRECOMPACTION_RATIO = 0.95;
// An overflow rejection proves the provider's effective window is below the
// failed request size, so the observation is stronger evidence than the
// advertised (possibly proxy-inflated) model window. The haircut absorbs the
// removed error message and estimator slop.
const OVERFLOW_WINDOW_EVIDENCE_RATIO = 0.9;

const isMessageEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> =>
  entry.type === "message";

const isHiddenEmptyCustom = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; display?: unknown; content?: unknown };
  if (candidate.role !== "custom" || candidate.display !== false) return false;
  const content = candidate.content;
  return content === "" || (Array.isArray(content) && content.length === 0);
};

const toolCallIdsOf = (message: { content?: unknown }): string[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall") continue;
    const id = (part as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
};

const contextMessages = (entry: SessionEntry): ReturnType<typeof sessionEntryToContextMessages> => {
  try {
    return sessionEntryToContextMessages(entry);
  } catch {
    return [];
  }
};

const findLastCompaction = (entries: SessionEntry[]): { index: number; firstKeptEntryId: string } | undefined => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "compaction") {
      return { index, firstKeptEntryId: entry.firstKeptEntryId };
    }
  }
  return undefined;
};

const collectContextEntries = (entries: SessionEntry[], startIndex: number): LiveEntry[] => {
  const contextEntries: LiveEntry[] = [];
  for (let index = Math.max(0, startIndex); index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.type === "compaction") continue;
    if (entry.type === "custom_message" && !isOmpCustomMessageEntry(entry)) continue;
    if (isMessageEntry(entry) && isHiddenEmptyCustom(entry.message)) continue;
    const messages = contextMessages(entry);
    if (messages.length === 0) continue;
    const roles = messages.map((message) => message.role);
    const rawMessage = isMessageEntry(entry)
      ? entry.message as NonNullable<LiveEntry["message"]>
      : undefined;
    contextEntries.push({
      entry,
      branchIndex: index,
      turnBoundary: roles.some((role) =>
        role === "user"
        || role === "custom"
        || role === "bashExecution"
        || role === "branchSummary"
        || role === "compactionSummary"),
      cutPoint: roles.some((role) => role !== "toolResult"),
      estimatedTokens: messages.reduce((total, message) => total + estimateTokens(message), 0),
      ...(rawMessage ? { message: rawMessage } : {}),
    });
  }
  return contextEntries;
};

const collectLive = (entries: SessionEntry[]): LiveEntry[] => {
  const last = findLastCompaction(entries);
  if (!last) return collectContextEntries(entries, 0);
  if (last.firstKeptEntryId) {
    const keptIndex = entries.findIndex((entry) => entry.id === last.firstKeptEntryId);
    if (keptIndex >= 0) return collectContextEntries(entries, keptIndex);
  }
  return collectContextEntries(entries, last.index + 1);
};

const previousBoundaryAtOrBefore = (live: LiveEntry[], branchIndex: number): number => {
  for (let index = live.length - 1; index >= 0; index--) {
    const item = live[index]!;
    if (item.branchIndex <= branchIndex && item.turnBoundary) return index;
  }
  return -1;
};

const lastBoundaryIndex = (live: LiveEntry[]): number => {
  for (let index = live.length - 1; index >= 0; index--) {
    if (live[index]!.turnBoundary) return index;
  }
  return -1;
};

const callResultSpans = (entries: SessionEntry[]): Map<string, CallResultSpan> => {
  const spans = new Map<string, CallResultSpan>();
  const record = (id: string, index: number, kind: "call" | "result"): void => {
    if (!id) return;
    const span = spans.get(id) ?? {
      first: index,
      last: index,
      hasCall: false,
      hasResult: false,
    };
    span.first = Math.min(span.first, index);
    span.last = Math.max(span.last, index);
    if (kind === "call") span.hasCall = true;
    else span.hasResult = true;
    spans.set(id, span);
  };
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isMessageEntry(entry)) continue;
    const message = entry.message as NonNullable<LiveEntry["message"]>;
    for (const id of toolCallIdsOf(message)) record(id, index, "call");
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      record(message.toolCallId, index, "result");
    }
  }
  return spans;
};

const spanCrosses = (span: CallResultSpan, boundaryIndex: number): boolean =>
  span.hasCall
  && span.hasResult
  && span.first < boundaryIndex
  && span.last >= boundaryIndex;

const closureSafe = (spans: Map<string, CallResultSpan>, boundaryIndex: number): boolean =>
  [...spans.values()].every((span) => !spanCrosses(span, boundaryIndex));

const closeCut = (
  branchEntries: SessionEntry[],
  live: LiveEntry[],
  candidateLiveIndex: number,
): number => {
  const spans = callResultSpans(branchEntries);
  let liveIndex = candidateLiveIndex;
  while (liveIndex > 0) {
    const boundaryIndex = live[liveIndex]!.branchIndex;
    let earliestCrossing = boundaryIndex;
    for (const span of spans.values()) {
      if (spanCrosses(span, boundaryIndex)) {
        earliestCrossing = Math.min(earliestCrossing, span.first);
      }
    }
    if (earliestCrossing === boundaryIndex) return liveIndex;
    const closed = previousBoundaryAtOrBefore(live, earliestCrossing);
    if (closed < 0 || closed >= liveIndex) return 0;
    liveIndex = closed;
  }
  return 0;
};

export const rawContextTokens = (branchEntries: SessionEntry[]): number =>
  buildSessionContext(branchEntries).messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );

interface UsageCheckpoint {
  rawTokens: number;
  contextTokens: number;
}

const usageCheckpoints = (branchEntries: SessionEntry[]): UsageCheckpoint[] => {
  const lastCompaction = findLastCompaction(branchEntries);
  const startIndex = lastCompaction ? lastCompaction.index + 1 : 0;
  let rawTokens = lastCompaction
    ? rawContextTokens(branchEntries.slice(0, lastCompaction.index + 1))
    : 0;
  const checkpoints: UsageCheckpoint[] = [];
  for (let index = startIndex; index < branchEntries.length; index++) {
    for (const message of contextMessages(branchEntries[index]!)) {
      rawTokens += estimateTokens(message);
      if (message.role !== "assistant") continue;
      const contextTokens = calculateContextTokens(message.usage);
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        checkpoints.push({ rawTokens, contextTokens });
      }
    }
  }
  return checkpoints;
};

// Fit an upper affine envelope: context ≈ fixed overhead + scale × raw messages.
// Only post-marker usage is comparable; the fallback treats all unexplained tokens as fixed.
const tokenCalibration = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  rawTokensBefore: number,
): { tokenScale: number; fixedOverheadTokens: number } => {
  const minimumDelta = Math.max(4_096, Math.floor(rawTokensBefore * 0.1));
  const checkpoints = usageCheckpoints(branchEntries).filter(
    (checkpoint) => checkpoint.rawTokens < rawTokensBefore
      && checkpoint.contextTokens <= tokensBefore,
  );
  const slopes = checkpoints.flatMap((checkpoint) => {
    const rawDelta = rawTokensBefore - checkpoint.rawTokens;
    const contextDelta = tokensBefore - checkpoint.contextTokens;
    return rawDelta >= minimumDelta && contextDelta >= 0
      ? [contextDelta / rawDelta]
      : [];
  }).filter((slope) => Number.isFinite(slope) && slope >= 0);

  if (slopes.length === 0) {
    return {
      tokenScale: 1,
      fixedOverheadTokens: Math.max(0, tokensBefore - rawTokensBefore),
    };
  }

  const tokenScale = Math.max(1, ...slopes);
  const fixedOverheadTokens = Math.max(
    0,
    tokensBefore - tokenScale * rawTokensBefore,
    ...checkpoints.map(
      (checkpoint) => checkpoint.contextTokens - tokenScale * checkpoint.rawTokens,
    ),
  );
  return { tokenScale, fixedOverheadTokens };
};

const continuityCutPlan = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  budget: FabricCompactionBudget,
): ContinuityCutPlan | undefined => {
  if (!Number.isFinite(budget.contextWindow) || budget.contextWindow <= 0) return undefined;
  const contextWindow = Math.floor(budget.contextWindow);
  const reserveTokens = Math.max(0, Math.floor(budget.reserveTokens));
  const keepRecentTokens = Math.max(0, Math.floor(budget.keepRecentTokens));
  const targetContextRatio = Math.max(0.25, Math.min(0.85, budget.targetContextRatio));
  const rawTokensBefore = rawContextTokens(branchEntries);
  const { tokenScale, fixedOverheadTokens } = tokenCalibration(
    branchEntries,
    tokensBefore,
    rawTokensBefore,
  );
  const continuityTargetTokens = Math.max(1, Math.ceil(
    fixedOverheadTokens + (keepRecentTokens + SUMMARY_RAW_TOKEN_BUDGET) * tokenScale,
  ));
  const occupancyCeilingTokens = Math.max(1, Math.floor(contextWindow * targetContextRatio));
  const hardCeiling = Math.max(1, contextWindow - reserveTokens);
  const safeCeilingTokens = Math.max(1, Math.floor(hardCeiling * HARD_CEILING_SAFETY_RATIO));
  const reductionCeilingTokens = Math.max(1, Math.floor(tokensBefore * MAX_PRECOMPACTION_RATIO));
  const constraints: Array<{
    binding: FabricCompactionBindingConstraint;
    tokens: number;
  }> = [
    { binding: "continuity", tokens: continuityTargetTokens },
    { binding: "occupancy", tokens: occupancyCeilingTokens },
    { binding: "reserve", tokens: safeCeilingTokens },
    { binding: "reduction", tokens: reductionCeilingTokens },
  ];
  const targetContextTokens = Math.min(...constraints.map(({ tokens }) => tokens));
  const bindingConstraint = constraints.find(
    ({ tokens }) => tokens === targetContextTokens,
  )!.binding;
  const rawPostBudget = Math.max(
    0,
    Math.floor((targetContextTokens - fixedOverheadTokens) / tokenScale),
  );
  return {
    contextWindow,
    targetContextRatio,
    targetContextTokens,
    reserveTokens,
    keepRecentTokens,
    rawTokensBefore,
    tokenScale,
    fixedOverheadTokens,
    continuityTargetTokens,
    occupancyCeilingTokens,
    safeCeilingTokens,
    reductionCeilingTokens,
    rawTailTokenBudget: Math.max(0, rawPostBudget - SUMMARY_RAW_TOKEN_BUDGET),
    bindingConstraint,
  };
};

export type CutResult =
  | {
      ok: true;
      summarized: SessionEntry[];
      firstKeptEntryId: string;
      firstSummarizedEntryId: string;
      lastSummarizedEntryId: string;
      lastTimestamp: string;
      budget?: Omit<FabricCompactionBudgetDetails, "projectedTokensAfter">;
    }
  | { ok: false; reason: "empty" };

const boundary = (
  summarized: SessionEntry[],
  firstKeptEntryId: string,
  budget?: Omit<FabricCompactionBudgetDetails, "projectedTokensAfter">,
): CutResult => {
  if (summarized.length === 0) return { ok: false, reason: "empty" };
  const first = summarized[0]!;
  const last = summarized.at(-1)!;
  return {
    ok: true,
    summarized,
    firstKeptEntryId,
    firstSummarizedEntryId: first.id,
    lastSummarizedEntryId: last.id,
    lastTimestamp: last.timestamp,
    ...(budget ? { budget } : {}),
  };
};

const computeContinuityCut = (
  branchEntries: SessionEntry[],
  live: LiveEntry[],
  plan: ContinuityCutPlan,
): CutResult => {
  const suffixTokens = new Array<number>(live.length + 1).fill(0);
  for (let index = live.length - 1; index >= 0; index--) {
    suffixTokens[index] = suffixTokens[index + 1]! + live[index]!.estimatedTokens;
  }
  const spans = callResultSpans(branchEntries);
  // OMP replays entries contiguously from firstKeptEntryId, including compaction markers.
  const previousCompactionIndex = findLastCompaction(branchEntries)?.index ?? -1;
  let cutIndex = live.length;
  for (let index = 1; index < live.length; index++) {
    const item = live[index]!;
    if (item.branchIndex <= previousCompactionIndex) continue;
    if (!item.cutPoint || suffixTokens[index]! > plan.rawTailTokenBudget) continue;
    if (!closureSafe(spans, item.branchIndex)) continue;
    cutIndex = index;
    break;
  }
  const retainedRawTokens = suffixTokens[cutIndex] ?? 0;
  const details = {
    strategy: "continuity" as const,
    contextWindow: plan.contextWindow,
    targetContextRatio: plan.targetContextRatio,
    targetContextTokens: plan.targetContextTokens,
    reserveTokens: plan.reserveTokens,
    keepRecentTokens: plan.keepRecentTokens,
    rawTokensBefore: plan.rawTokensBefore,
    tokenScale: plan.tokenScale,
    fixedOverheadTokens: plan.fixedOverheadTokens,
    retainedRawTokens,
    continuityTargetTokens: plan.continuityTargetTokens,
    occupancyCeilingTokens: plan.occupancyCeilingTokens,
    safeCeilingTokens: plan.safeCeilingTokens,
    reductionCeilingTokens: plan.reductionCeilingTokens,
    rawTailTokenBudget: plan.rawTailTokenBudget,
    bindingConstraint: plan.bindingConstraint,
  };
  if (cutIndex >= live.length) {
    return boundary(live.map((item) => item.entry), "", details);
  }
  return boundary(
    live.slice(0, cutIndex).map((item) => item.entry),
    live[cutIndex]!.entry.id,
    details,
  );
};

export const computeCut = (
  branchEntries: SessionEntry[],
  options?: { tokensBefore: number; budget: FabricCompactionBudget },
): CutResult => {
  const live = collectLive(branchEntries);
  if (live.length === 0) return { ok: false, reason: "empty" };

  if (options) {
    const plan = continuityCutPlan(branchEntries, options.tokensBefore, options.budget);
    if (plan) return computeContinuityCut(branchEntries, live, plan);
  }

  const lastBoundary = lastBoundaryIndex(live);
  if (lastBoundary <= 0) return boundary(live.map((item) => item.entry), "");
  const closed = closeCut(branchEntries, live, lastBoundary);
  const previousCompactionIndex = findLastCompaction(branchEntries)?.index ?? -1;
  if (closed <= 0 || live[closed]!.branchIndex <= previousCompactionIndex) {
    return boundary(live.map((item) => item.entry), "");
  }

  return boundary(
    live.slice(0, closed).map((item) => item.entry),
    live[closed]!.entry.id,
  );
};

interface FabricCompactionDetailsV1 {
  compactor: "fabric";
  version: 1;
  sections: string[];
  summarizedEntryRange: { first: string; last: string };
  sourceEntryCount: number;
  firstKeptEntryId: string;
  timestamp: string;
}

interface EntryRange {
  first: string;
  last: string;
}

export interface FabricCompactionDetailsV2 {
  compactor: "fabric";
  version: 2;
  sections: string[];
  coverage: {
    cumulativeSourceRange: EntryRange;
    liveCutRange: EntryRange;
  };
  counts: {
    branchEntries: number;
    cumulativeSourceEntries: number;
    sourceEvents: number;
    liveCutEntries: number;
    priorFabricV1: number;
    priorFabricV2: number;
  };
  omittedCounts: ProjectionOmittedCounts & { preserve: number; thinking?: number };
  instructionPolicy: CompactionInstructionPolicy;
  stableAddresses: {
    firstKeptEntryId: string;
    cumulativeSourceRange: EntryRange;
    recall: "session-entry-id-range";
  };
  budget?: FabricCompactionBudgetDetails;
  timestamp: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isEntryRange = (value: unknown): boolean =>
  isRecord(value) && typeof value.first === "string" && typeof value.last === "string";

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isFabricV1Details = (value: Record<string, unknown>): boolean =>
  isStringArray(value.sections)
  && isEntryRange(value.summarizedEntryRange)
  && typeof value.sourceEntryCount === "number"
  && Number.isFinite(value.sourceEntryCount)
  && typeof value.firstKeptEntryId === "string"
  && typeof value.timestamp === "string";

const hasFiniteNumbers = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));

const isCompactionBudgetDetails = (value: unknown): boolean => {
  if (!isRecord(value) || (value.strategy !== "adaptive" && value.strategy !== "continuity")) {
    return false;
  }
  if (!hasFiniteNumbers(value, [
    "contextWindow",
    "targetContextRatio",
    "targetContextTokens",
    "reserveTokens",
    "keepRecentTokens",
    "rawTokensBefore",
    "tokenScale",
    "fixedOverheadTokens",
    "retainedRawTokens",
    "projectedTokensAfter",
  ])) {
    return false;
  }
  if (value.strategy === "adaptive") return true;
  return hasFiniteNumbers(value, [
    "continuityTargetTokens",
    "occupancyCeilingTokens",
    "safeCeilingTokens",
    "reductionCeilingTokens",
    "rawTailTokenBudget",
  ])
    && (
      value.bindingConstraint === "continuity"
      || value.bindingConstraint === "occupancy"
      || value.bindingConstraint === "reserve"
      || value.bindingConstraint === "reduction"
    );
};

const isFabricV2Details = (value: Record<string, unknown>): boolean => {
  if (!isStringArray(value.sections) || !isRecord(value.coverage) || !isRecord(value.counts)) return false;
  if (!isRecord(value.omittedCounts) || !isRecord(value.instructionPolicy) || !isRecord(value.stableAddresses)) {
    return false;
  }
  const instructionModes = new Set(["none", "plain", "typed-v1", "malformed-typed-prefix"]);
  return isEntryRange(value.coverage.cumulativeSourceRange)
    && isEntryRange(value.coverage.liveCutRange)
    && hasFiniteNumbers(value.counts, [
      "branchEntries",
      "cumulativeSourceEntries",
      "sourceEvents",
      "liveCutEntries",
      "priorFabricV1",
      "priorFabricV2",
    ])
    && hasFiniteNumbers(value.omittedCounts, [
      "goal",
      "files",
      "outstanding",
      "earlierTurns",
      "transcript",
      "preserve",
    ])
    && (value.omittedCounts.activity === undefined
      || (typeof value.omittedCounts.activity === "number" && Number.isFinite(value.omittedCounts.activity)))
    && (value.omittedCounts.commits === undefined
      || (typeof value.omittedCounts.commits === "number" && Number.isFinite(value.omittedCounts.commits)))
    && (value.omittedCounts.thinking === undefined
      || (typeof value.omittedCounts.thinking === "number" && Number.isFinite(value.omittedCounts.thinking)))
    && typeof value.instructionPolicy.mode === "string"
    && instructionModes.has(value.instructionPolicy.mode)
    && typeof value.instructionPolicy.canonicalized === "boolean"
    && typeof value.instructionPolicy.truncated === "boolean"
    && hasFiniteNumbers(value.instructionPolicy, [
      "sourceBytes",
      "preserveCount",
      "omittedPreserveCount",
    ])
    && typeof value.stableAddresses.firstKeptEntryId === "string"
    && isEntryRange(value.stableAddresses.cumulativeSourceRange)
    && value.stableAddresses.recall === "session-entry-id-range"
    && (value.budget === undefined || isCompactionBudgetDetails(value.budget))
    && typeof value.timestamp === "string";
};

export const fabricCompactionVersion = (details: unknown): 1 | 2 | undefined => {
  if (!isRecord(details) || details.compactor !== "fabric") return undefined;
  if (details.version === 1 && isFabricV1Details(details)) return 1;
  if (details.version === 2 && isFabricV2Details(details)) return 2;
  return undefined;
};

const cumulativeSource = (
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
): { entries: SessionEntry[]; prefixEntries: SessionEntry[]; events: ReturnType<typeof normalizeEntries>; range: EntryRange; timestamp: string } => {
  const boundaryIndex = firstKeptEntryId
    ? branchEntries.findIndex((entry) => entry.id === firstKeptEntryId)
    : branchEntries.length;
  const prefix = branchEntries.slice(0, boundaryIndex >= 0 ? boundaryIndex : branchEntries.length);
  const events = normalizeEntries(prefix);
  const contentEntryIds = new Set(events.map((event) => event.sourceEntryId));
  const entries = prefix.filter((entry) => contentEntryIds.has(entry.id));
  return {
    entries,
    prefixEntries: prefix,
    events,
    range: {
      first: entries[0]?.id ?? "",
      last: entries.at(-1)?.id ?? "",
    },
    timestamp: entries.at(-1)?.timestamp ?? "",
  };
};

const priorFabricVersions = (entries: SessionEntry[]): { v1: number; v2: number } => {
  let v1 = 0;
  let v2 = 0;
  for (const entry of entries) {
    if (entry.type !== "compaction") continue;
    const version = fabricCompactionVersion((entry as SessionEntry & { details?: unknown }).details);
    if (version === 1) v1 += 1;
    if (version === 2) v2 += 1;
  }
  return { v1, v2 };
};

export const compileFabricSummary = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  enrichers: readonly CompactionEnricher[] = NO_BUILTIN_ENRICHERS,
  customInstructions?: string,
  budget?: FabricCompactionBudget,
): { compaction: CompactionResult<FabricCompactionDetailsV2> } | {
  cancel: true;
  reason: string;
  instructionError?: CompactionInstructionDecodeError;
} => {
  const instructions = decodeCompactionInstructions(customInstructions);
  if (!instructions.ok) {
    return {
      cancel: true,
      reason: `fabric: ${instructions.error.code}: ${instructions.error.message}`,
      instructionError: instructions.error,
    };
  }
  const cut = computeCut(
    branchEntries,
    budget ? { tokensBefore, budget } : undefined,
  );
  if (!cut.ok) return { cancel: true, reason: "fabric: nothing to compact" };

  const source = cumulativeSource(branchEntries, cut.firstKeptEntryId);
  if (source.events.length === 0) return { cancel: true, reason: "fabric: no raw cumulative source" };
  const projected = projectWithMetadata(source.events);
  const sections: Sections = projected.sections;
  runEnrichers(enrichers, source.events, sections);

  const summary = renderSummary(sections, {
    firstEntryId: source.range.first,
    lastEntryId: source.range.last,
    lastTimestamp: source.timestamp,
    requestLines: instructions.requestLines,
  });
  const projectedTokensAfter = cut.budget
    ? Math.ceil(
        cut.budget.fixedOverheadTokens
        + (cut.budget.retainedRawTokens + Math.ceil(summary.length / 4))
        * cut.budget.tokenScale,
      )
    : undefined;
  const budgetDetails = cut.budget && projectedTokensAfter !== undefined
    ? { ...cut.budget, projectedTokensAfter }
    : undefined;
  // The maximum-summary reservation should make this unreachable unless fixed overhead alone
  // makes the target infeasible. Never persist an expanding or nominally unsafe result.
  if (budgetDetails && budgetDetails.projectedTokensAfter > budgetDetails.targetContextTokens) {
    return {
      cancel: true,
      reason: "fabric: no deterministic summary fits the continuity context target",
    };
  }
  const versions = priorFabricVersions(branchEntries);
  const sectionHeaders = SECTION_HEADERS
    .filter(({ key }) => sections[key].length > 0)
    .map(({ header }) => header);
  if (instructions.requestLines.length > 0) sectionHeaders.splice(1, 0, "[Compaction Request]");

  const details: FabricCompactionDetailsV2 = {
    compactor: "fabric",
    version: 2,
    sections: sectionHeaders,
    coverage: {
      cumulativeSourceRange: source.range,
      liveCutRange: {
        first: cut.firstSummarizedEntryId,
        last: cut.lastSummarizedEntryId,
      },
    },
    counts: {
      branchEntries: branchEntries.length,
      cumulativeSourceEntries: source.entries.length,
      sourceEvents: source.events.length,
      liveCutEntries: cut.summarized.length,
      priorFabricV1: versions.v1,
      priorFabricV2: versions.v2,
    },
    omittedCounts: {
      ...projected.omittedCounts,
      preserve: instructions.policy.omittedPreserveCount,
      // Thinking parts never survive normalization into a rendered summary;
      // the structural count keeps that erasure auditable against the raw
      // prefix instead of letting deliberation vanish untracked.
      thinking: countErasedThinkingBlocks(source.prefixEntries),
    },
    instructionPolicy: instructions.policy,
    stableAddresses: {
      firstKeptEntryId: cut.firstKeptEntryId,
      cumulativeSourceRange: source.range,
      recall: "session-entry-id-range",
    },
    ...(budgetDetails ? { budget: budgetDetails } : {}),
    timestamp: source.timestamp,
  };

  return {
    compaction: {
      summary,
      firstKeptEntryId: cut.firstKeptEntryId,
      tokensBefore,
      details,
    },
  };
};

const SECTION_HEADERS: { key: keyof Sections; header: string }[] = [
  { key: "goal", header: "[Session Goal]" },
  { key: "files", header: "[Files And Changes]" },
  { key: "activity", header: "[Fabric Activity]" },
  { key: "outstanding", header: "[Outstanding Context]" },
  { key: "earlierTurns", header: "[Earlier Turns]" },
  { key: "status", header: "[Current Status]" },
];

export interface LcmCompactionInput {
  branchEntries: readonly SessionEntry[];
  sessionId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  customInstructions?: string;
}

export interface LcmCompactionOutput {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  source: "ready-frontier" | "emergency";
  details?: unknown;
}

interface LcmCompactionOptions {
  compact: (input: LcmCompactionInput) => LcmCompactionOutput | undefined;
}

export interface CompactionHookOptions {
  getEngine: () => CompactionEngine;
  getTargetContextRatio?: () => number;
  enrichers?: readonly CompactionEnricher[];
  lcm?: LcmCompactionOptions;
}

const notifyInstructionError = (
  context: ExtensionContext | undefined,
  error: CompactionInstructionDecodeError,
): void => {
  if (!context?.hasUI) return;
  context.ui.notify(clipUtf8(`Fabric compaction rejected: ${error.code}: ${error.message}`, 512), "error");
};

export const registerCompactionHook = (omp: ExtensionAPI, options: CompactionHookOptions): void => {
  omp.on("session_before_compact", (event: SessionBeforeCompactEvent, context: ExtensionContext) => {
    if (options.getEngine() === "omp") return;
    if (!options.lcm) return { cancel: true };
    const instructions = decodeCompactionInstructions(event.customInstructions);
    if (!instructions.ok) {
      notifyInstructionError(context, instructions.error);
      return { cancel: true };
    }
    const branchEntries = event.branchEntries ?? [];
    const sessionManager = context?.sessionManager;
    const sessionId = sessionManager?.getSessionId?.() ?? "";
    let output: LcmCompactionOutput | undefined;
    try {
      output = options.lcm.compact({
        branchEntries,
        sessionId,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[omp-fabric] LCM compaction failed: ${message}`);
      if (context?.hasUI) context.ui.notify(`LCM compaction failed: ${message}`, "error");
      return { cancel: true };
    }
    if (!output || typeof output.summary !== "string" || output.summary.length === 0
      || (output.source !== "ready-frontier" && output.source !== "emergency")
      || output.tokensBefore !== event.preparation.tokensBefore
      || typeof output.firstKeptEntryId !== "string"
      || branchEntries.length === 0
      || (output.firstKeptEntryId.length > 0 && !branchEntries.some((entry) => entry.id === output.firstKeptEntryId))) {
      return { cancel: true };
    }
    return {
      compaction: {
        summary: output.summary,
        firstKeptEntryId: output.firstKeptEntryId,
        tokensBefore: output.tokensBefore,
        details: {
          compactor: "lcm",
          source: output.source,
          ...(output.details && typeof output.details === "object" ? output.details : {}),
        },
      },
    };
  });

  omp.on("session_before_tree", (event: SessionBeforeTreeEvent) => {
    if (options.getEngine() !== "lcm" || !event.preparation.userWantsSummary) return;
    const compiled = compileLcmBranchSummary(
      event.preparation.entriesToSummarize,
      undefined,
      options.enrichers,
      event.preparation.oldLeafId,
    );
    if (!compiled) return;
    return { summary: compiled };
  });
};
