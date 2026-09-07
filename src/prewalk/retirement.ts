import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { AgentSessionSeed } from "../agents/types.js";

export type TranscriptEntry = SessionEntry;

export const RETIREMENT_RECENCY_WINDOW = 3;

export const RETIREMENT_MIN_BYTES = 512;

const RETIREABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

const MAX_TARGET_CHARS = 200;

export interface RetirementOptions {
  handoffRetirement?: boolean;
  recencyWindow?: number;
  handoffRetirementKeep?: number;
  minBytes?: number;
}

interface RetiredResult {
  entryId: string;
  toolCallId: string;
  toolName: string;
  target?: string;
  bytes: number;
  marker: string;
}

export interface RetirementPlan {
  enabled: boolean;
  candidates: number;
  retired: RetiredResult[];
  bytesRetired: number;
  markerBytes: number;
}

export interface SeedRetirement {
  seed: AgentSessionSeed;
  plan: RetirementPlan;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textBytes = (value: string): number => Buffer.byteLength(value, "utf8");

const jsonBytes = (value: unknown): number => {
  if (value === undefined) return 0;
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? textBytes(encoded) : 0;
  } catch {
    return 0;
  }
};

const emptyPlan = (enabled: boolean): RetirementPlan => ({
  enabled,
  candidates: 0,
  retired: [],
  bytesRetired: 0,
  markerBytes: 0,
});

const isTextBlock = (block: unknown): block is { type: "text"; text: string } =>
  isRecord(block) && block.type === "text" && typeof block.text === "string";

const textOnlyContent = (content: unknown): content is unknown[] =>
  Array.isArray(content) && content.every(isTextBlock);

const resultBytes = (message: Record<string, unknown>): number => {
  let bytes = 0;
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) if (isTextBlock(block)) bytes += textBytes(block.text);
  }
  return bytes + jsonBytes(message.details);
};

const retireableToolName = (name: unknown): string | undefined => {
  if (typeof name !== "string") return undefined;
  const bare = name.startsWith("omp.") ? name.slice(4) : name;
  return RETIREABLE_TOOLS.has(bare) ? bare : undefined;
};

const clipTarget = (value: string): string =>
  value.length > MAX_TARGET_CHARS ? `${value.slice(0, MAX_TARGET_CHARS)}…` : value;

const targetFromArguments = (args: unknown): string | undefined => {
  if (!isRecord(args)) return undefined;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const needle = ["pattern", "glob", "query"]
    .map((key) => (typeof args[key] === "string" ? (args[key] as string).trim() : ""))
    .find((value) => value.length > 0);
  if (needle && path) return clipTarget(`${needle} @ ${path}`);
  const target = path || needle;
  return target ? clipTarget(target) : undefined;
};

const retirementMarker = (
  toolName: string,
  target: string | undefined,
  bytes: number,
): string =>
  target
    ? `[omp-fabric] retired ${toolName} result for ${target} (${bytes} bytes) — re-run ${toolName} on ${target} to recover it.`
    : `[omp-fabric] retired ${toolName} result (${bytes} bytes) — re-run ${toolName} to recover it.`;

const collectToolCallArguments = (
  message: Record<string, unknown>,
  into: Map<string, unknown>,
): void => {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (typeof block.id !== "string") continue;
    into.set(block.id, block.arguments);
  }
};

const positiveInteger = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;

export const planRetirement = (
  entries: ReadonlyArray<TranscriptEntry> | undefined,
  options: RetirementOptions = {},
): RetirementPlan => {
  const enabled = options.handoffRetirement === true;
  if (!enabled || !Array.isArray(entries)) return emptyPlan(enabled);
  const recencyWindow = positiveInteger(
    options.recencyWindow,
    positiveInteger(options.handoffRetirementKeep, RETIREMENT_RECENCY_WINDOW),
  );
  const minBytes = positiveInteger(options.minBytes, RETIREMENT_MIN_BYTES);
  try {
    const callArguments = new Map<string, unknown>();
    const candidates: RetiredResult[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "message") continue;
      const message = entry.message;
      if (!isRecord(message)) continue;
      if (message.role === "assistant") {
        collectToolCallArguments(message, callArguments);
        continue;
      }
      if (message.role !== "toolResult") continue;
      if (message.isError !== false) continue;
      if (message.prunedAt !== undefined) continue;
      const toolName = retireableToolName(message.toolName);
      if (!toolName) continue;
      if (!textOnlyContent(message.content)) continue;
      const entryId = typeof entry.id === "string" ? entry.id : undefined;
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      if (!entryId || !toolCallId) continue;
      const bytes = resultBytes(message);
      if (bytes < minBytes) continue;
      const target = targetFromArguments(callArguments.get(toolCallId));
      candidates.push({
        entryId,
        toolCallId,
        toolName,
        ...(target ? { target } : {}),
        bytes,
        marker: retirementMarker(toolName, target, bytes),
      });
    }
    const retired = candidates.slice(0, Math.max(0, candidates.length - recencyWindow));
    let bytesRetired = 0;
    let markerBytes = 0;
    for (const item of retired) {
      bytesRetired += item.bytes;
      markerBytes += textBytes(item.marker);
    }
    return { enabled, candidates: candidates.length, retired, bytesRetired, markerBytes };
  } catch {
    return emptyPlan(enabled);
  }
};

const withoutDetails = (message: Record<string, unknown>): Record<string, unknown> => {
  if (message.details === undefined) return { ...message };
  const copy = { ...message };
  delete copy.details;
  return copy;
};

export const applyRetirement = (
  entries: ReadonlyArray<TranscriptEntry>,
  plan: RetirementPlan,
  prunedAt: number = Date.now(),
): TranscriptEntry[] => {
  if (!Array.isArray(entries) || plan.retired.length === 0) return entries as TranscriptEntry[];
  try {
    const byEntryId = new Map(plan.retired.map((item) => [item.entryId, item] as const));
    return entries.map((entry) => {
      if (!isRecord(entry)) return entry;
      const retired = typeof entry.id === "string" ? byEntryId.get(entry.id) : undefined;
      if (!retired || !isRecord(entry.message)) return entry;
      return {
        ...entry,
        message: {
          ...withoutDetails(entry.message),
          content: [{ type: "text", text: retired.marker }],
          prunedAt,
        },
      } as TranscriptEntry;
    });
  } catch {
    return entries as TranscriptEntry[];
  }
};

export const retireHandoffSeed = (
  seed: AgentSessionSeed,
  options: RetirementOptions = {},
): SeedRetirement => {
  try {
    const branch = seed.sourceBranch;
    if (options.handoffRetirement !== true || !Array.isArray(branch)) {
      return { seed, plan: planRetirement(undefined, options) };
    }
    const plan = planRetirement(branch, options);
    if (plan.retired.length === 0) return { seed, plan };
    return { seed: { ...seed, sourceBranch: applyRetirement(branch, plan) }, plan };
  } catch {
    return { seed, plan: emptyPlan(false) };
  }
};
