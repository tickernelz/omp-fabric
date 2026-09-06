import type {
  SessionEntry,
  SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";

// Cross-model thinking transfer for trajectory handoffs.
//
// OMP replays stored thinking blocks verbatim per provider: a Codex Responses
// reasoning item rides as a provider-shaped `thinkingSignature` blob, and the
// OpenAI-completions transform (pi-ai) uses that blob as the *request field
// name* when the history is handed to a different provider — landing prior
// deliberation in a junk field while the real `reasoning_content` stays
// empty. Signature-sensitive families (Anthropic) reject foreign signatures
// outright. This module applies a family-aware policy to the fabric-owned
// child session at the handoff boundary, where rewriting is safe because the
// source session (ground truth) is never touched:
//
//   preserved — same provider and api family: native replay already works.
//   re-signed — openai-completions reasoning targets: thinking text is kept
//     and the signature normalized to "reasoning_content" so preserve-thinking
//     servers (Kimi, DeepSeek, …) actually receive prior reasoning.
//   stripped — everything else: thinking blocks and foreign thought
//     signatures are removed so no bogus field or invalid signature is sent;
//     a bounded, entry-id-cited digest keeps continuity instead.

interface ThinkingTransferSource {
  provider: string;
  modelId: string;
  /** pi-ai transport api of the source model, when the registry resolves it. */
  api?: string | undefined;
}

interface ThinkingTransferTarget {
  provider: string;
  modelId: string;
  api?: string | undefined;
  reasoning?: boolean | undefined;
  /** Model replays thinking as visible text; deliberation must not leak there. */
  requiresThinkingAsText?: boolean | undefined;
}

export interface ThinkingTransferInput {
  source?: ThinkingTransferSource;
  target: ThinkingTransferTarget;
}

export type ThinkingTransferPolicy = "preserved" | "re-signed" | "stripped";

export interface ThinkingTransferReport {
  policy: ThinkingTransferPolicy;
  translated: number;
  dropped: number;
}

// Field name pi-ai emits when a thinking block's signature is exactly this
// string (the opencode-go "reasoning" → "reasoning_content" remap proves the
// convention): the request then carries real prior reasoning content.
export const REASONING_CONTENT_SIGNATURE = "reasoning_content";

const OPENAI_COMPLETIONS_API = "openai-completions";

export const thinkingTransferPolicy = (
  input: ThinkingTransferInput,
): ThinkingTransferPolicy => {
  const { source, target } = input;
  // Same provider with equal or unknown apis: native replay is provider-shipped
  // and the default experience; only an api-proof mismatch transfers.
  if (
    source &&
    source.provider === target.provider &&
    (source.api === undefined || target.api === undefined || source.api === target.api)
  ) {
    return "preserved";
  }
  if (
    target.api === OPENAI_COMPLETIONS_API &&
    target.reasoning === true &&
    target.requiresThinkingAsText !== true
  ) {
    return "re-signed";
  }
  return "stripped";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isThinkingPart = (part: unknown): part is Record<string, unknown> =>
  isRecord(part) && part.type === "thinking";

// Clone-and-rewrite walk over assistant content parts. Also clears foreign
// `thoughtSignature` artifacts (Google-style reasoning_details), which are as
// provider-bound as thinking signatures. Callers own the input; the original
// entries are never mutated.
export const translateThinkingForExecutor = (
  entries: SessionEntry[],
  policy: ThinkingTransferPolicy,
): { entries: SessionEntry[]; report: ThinkingTransferReport } => {
  if (policy === "preserved") {
    return { entries, report: { policy, translated: 0, dropped: 0 } };
  }
  const clone = structuredClone(entries);
  let translated = 0;
  let dropped = 0;
  for (const entry of clone) {
    if (entry.type !== "message") continue;
    const message = (entry as SessionMessageEntry).message as {
      role?: unknown;
      content?: unknown;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const kept: unknown[] = [];
    for (const part of message.content as unknown[]) {
      if (isRecord(part) && part.type === "toolCall") {
        delete part.thoughtSignature;
        kept.push(part);
        continue;
      }
      if (!isThinkingPart(part)) {
        kept.push(part);
        continue;
      }
      const text = typeof part.thinking === "string" ? part.thinking : "";
      if (policy === "re-signed" && part.redacted !== true && text.trim().length > 0) {
        part.thinkingSignature = REASONING_CONTENT_SIGNATURE;
        translated += 1;
        kept.push(part);
        continue;
      }
      dropped += 1;
    }
    message.content = kept;
  }
  return { entries: clone, report: { policy, translated, dropped } };
};

export const THINKING_DIGEST_CUSTOM_TYPE = "omp-fabric-handoff-thinking";

const MAX_DIGEST_BLOCKS = 8;
const MAX_DIGEST_LINE = 80;
const MAX_DIGEST_BYTES = 2048;

export interface ThinkingDigest {
  content: string;
  citedBlocks: number;
}

const firstLineOf = (text: string): string => {
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end);
};

const truncate = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

const clipUtf8 = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
};

// Bounded continuity bridge for executors whose reasoning channel cannot
// accept prior thinking: the newest few first-lines, cited by stable entry id,
// explicitly labeled as deliberation so they read as context, not style. The
// full scratchpad remains addressable in the source session.
export const buildThinkingDigest = (
  entries: SessionEntry[],
  input: ThinkingTransferInput,
): ThinkingDigest | undefined => {
  const blocks: Array<{ entryId: string; line: string }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as SessionMessageEntry).message as {
      role?: unknown;
      content?: unknown;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (!isThinkingPart(part)) continue;
      const text = typeof part.thinking === "string" ? part.thinking : "";
      const line = truncate(firstLineOf(text).trim(), MAX_DIGEST_LINE);
      if (line) blocks.push({ entryId: entry.id, line });
    }
  }
  if (blocks.length === 0) return undefined;
  const recent = blocks.slice(-MAX_DIGEST_BLOCKS);
  const omitted = blocks.length - recent.length;
  const sourceId = input.source
    ? `${input.source.provider}/${input.source.modelId}`
    : "the prior model";
  const targetId = `${input.target.provider}/${input.target.modelId}`;
  const lines = [
    "Prewalk handoff continuity digest (deliberation, not commitments).",
    `Thinking from ${sourceId} was not transferred: ${targetId} cannot replay it (incompatible reasoning channels). Most recent lines:`,
    ...recent.map((block) => `- [entry ${block.entryId}] ${block.line}`),
  ];
  if (omitted > 0) lines.push(`(omitted ${omitted} older thinking blocks)`);
  lines.push("Full thinking remains addressable in the source session by entry id.");
  return {
    content: clipUtf8(lines.join("\n"), MAX_DIGEST_BYTES),
    citedBlocks: recent.length,
  };
};
