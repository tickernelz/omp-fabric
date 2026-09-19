// Mirrors the OMP host tokenizer for the block and role kinds Fabric projects,
// verified against @oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim.

const IMAGE_TOKEN_ESTIMATE = 1200;
const FRAME_TOKEN_ESTIMATE = 5024;

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;

interface TokenContentPart {
  type: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  data?: string;
  block?: unknown;
  name?: string;
  arguments?: unknown;
}

type TokenMessage = {
  role: string;
  content?: unknown;
  command?: unknown;
  output?: unknown;
  summary?: unknown;
  blocks?: readonly TokenContentPart[];
  images?: readonly unknown[];
};

const contentParts = (content: unknown): readonly TokenContentPart[] =>
  Array.isArray(content) ? (content as readonly TokenContentPart[]) : [];

const stringifyArguments = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    try {
      return JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? nested.toString() : nested)) ?? "null";
    } catch {
      return "null";
    }
  }
};

const blockTokens = (chars: number): number => (chars > 0 ? Math.ceil(chars / 4) : 0);

const textLength = (value: unknown): number =>
  typeof value === "string" ? Buffer.byteLength(value, "utf-8") : 0;

export const estimateTokens = (message: TokenMessage): number => {
  let tokens = 0;
  switch (message.role) {
    case "user":
    case "developer": {
      if (typeof message.content === "string") return blockTokens(textLength(message.content));
      for (const block of contentParts(message.content)) {
        if (block.type === "text") tokens += blockTokens(textLength(block.text));
        else if (block.type === "image") tokens += IMAGE_TOKEN_ESTIMATE;
      }
      return tokens;
    }
    case "assistant": {
      for (const block of contentParts(message.content)) {
        if (block.type === "text") {
          tokens += blockTokens(textLength(block.text));
        } else if (block.type === "thinking") {
          tokens += blockTokens(textLength(block.thinking));
          tokens += blockTokens(textLength(block.thinkingSignature));
        } else if (block.type === "toolCall") {
          tokens += blockTokens(textLength(block.name));
          tokens += blockTokens(textLength(stringifyArguments(block.arguments)));
        } else if (block.type === "redactedThinking") {
          tokens += blockTokens(textLength(block.data));
        } else if (block.type === "anthropicServerTool") {
          tokens += blockTokens(textLength(stringifyArguments(block.block)));
        }
      }
      return tokens;
    }
    case "custom":
    case "hookMessage":
    case "toolResult": {
      if (typeof message.content === "string") return blockTokens(textLength(message.content));
      for (const block of contentParts(message.content)) {
        if (block.type === "text") tokens += blockTokens(textLength(block.text));
        else if (block.type === "image") tokens += IMAGE_TOKEN_ESTIMATE;
      }
      return tokens;
    }
    case "bashExecution":
      return blockTokens(textLength(message.command)) + blockTokens(textLength(message.output));
    case "branchSummary":
      return blockTokens(textLength(message.summary));
    case "compactionSummary": {
      tokens = blockTokens(textLength(message.summary));
      if (message.blocks) {
        for (const block of message.blocks) {
          if (block.type === "text") tokens += blockTokens(textLength(block.text));
          else tokens += FRAME_TOKEN_ESTIMATE;
        }
      } else if (message.images) {
        tokens += message.images.length * FRAME_TOKEN_ESTIMATE;
      }
      return tokens;
    }
  }
  return 0;
};

export const calculateContextTokens = (usage: unknown): number => {
  if (typeof usage !== "object" || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  const totalTokens = record.totalTokens;
  // Host evaluates `usage.totalTokens || input + output + ...`; zero and
  // missing totals both fall through to the component sum.
  if (typeof totalTokens === "number" && totalTokens > 0) return totalTokens;
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  return count(record.input) + count(record.output) + count(record.cacheRead) + count(record.cacheWrite);
};
