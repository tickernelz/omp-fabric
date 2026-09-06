// Mirrors the OMP host tokenizer for the block and role kinds Fabric projects,
// verified against @oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim.

const ESTIMATED_IMAGE_CHARS = 4800;

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;

interface TokenContentPart {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

type TokenMessage = {
  role: string;
  content?: unknown;
  command?: unknown;
  output?: unknown;
  summary?: unknown;
};

const contentParts = (content: unknown): readonly TokenContentPart[] => {
  if (typeof content !== "string") return (content ?? []) as readonly TokenContentPart[];
  return [];
};

const blockTokens = (chars: number): number => (chars > 0 ? Math.ceil(chars / 4) : 0);

const textLength = (value: unknown): number => (typeof value === "string" ? value.length : 0);

const imageTokens = (): number => blockTokens(ESTIMATED_IMAGE_CHARS);

export const estimateTokens = (message: TokenMessage): number => {
  let tokens = 0;
  switch (message.role) {
    case "user": {
      if (typeof message.content === "string") return blockTokens(message.content.length);
      for (const block of contentParts(message.content)) {
        if (block.type === "text") tokens += blockTokens(textLength(block.text));
      }
      return tokens;
    }
    case "assistant": {
      for (const block of contentParts(message.content)) {
        if (block.type === "text") {
          tokens += blockTokens(textLength(block.text));
        } else if (block.type === "thinking") {
          tokens += blockTokens(textLength(block.thinking));
        } else if (block.type === "toolCall") {
          tokens += blockTokens(textLength(block.name));
          tokens += blockTokens((JSON.stringify(block.arguments) ?? "null").length);
        }
      }
      return tokens;
    }
    case "custom":
      return 0;
    case "toolResult": {
      if (typeof message.content === "string") return blockTokens(message.content.length);
      for (const block of contentParts(message.content)) {
        if (block.type === "text") tokens += blockTokens(textLength(block.text));
        else if (block.type === "image") tokens += imageTokens();
      }
      return tokens;
    }
    case "bashExecution":
      return blockTokens(textLength(message.command)) + blockTokens(textLength(message.output));
    case "branchSummary":
    case "compactionSummary":
      return blockTokens(textLength(message.summary));
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
