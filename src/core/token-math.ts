import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { calculateContextTokens as hostCalculateContextTokens } from "@oh-my-pi/pi-agent-core/compaction";

const tokenizer = new Tokenizer();

export type TokenMessage = Parameters<Tokenizer["countMessage"]>[0];

export const estimateTokens = (message: TokenMessage): number => tokenizer.countMessage(message);

export const calculateContextTokens = (usage: unknown): number =>
  typeof usage === "object" && usage !== null ? hostCalculateContextTokens(usage as never) : 0;

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;
