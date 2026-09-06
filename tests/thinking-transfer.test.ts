import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";
import {
  buildThinkingDigest,
  REASONING_CONTENT_SIGNATURE,
  thinkingTransferPolicy,
  translateThinkingForExecutor,
  type ThinkingTransferInput,
} from "../src/agents/thinking-transfer.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (id: string, content: unknown[]): SessionEntry =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content,
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage,
      stopReason: "stop",
      timestamp: 1,
    },
  }) as unknown as SessionEntry;

const user = (id: string, text: string): SessionEntry =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  }) as unknown as SessionEntry;

const CODEX_BLOB =
  '{"id":"rs_074b3fd","type":"reasoning","encrypted_content":"gAAAABlob"}';

const codexSource = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  api: "openai-responses",
};

const kimi: ThinkingTransferInput = {
  source: codexSource,
  target: { provider: "neuralwatt", modelId: "kimi-k3", api: "openai-completions", reasoning: true },
};

describe("thinking transfer policy", () => {
  it("preserves same provider and api family", () => {
    expect(
      thinkingTransferPolicy({
        source: { provider: "anthropic", modelId: "a", api: "anthropic-messages" },
        target: { provider: "anthropic", modelId: "b", api: "anthropic-messages", reasoning: true },
      }),
    ).toBe("preserved");
  });

  it("preserves same provider when either api is unknown", () => {
    expect(
      thinkingTransferPolicy({
        source: { provider: "anthropic", modelId: "a" },
        target: { provider: "anthropic", modelId: "b", api: "anthropic-messages", reasoning: true },
      }),
    ).toBe("preserved");
  });

  it("re-signs for openai-completions reasoning targets across providers", () => {
    expect(thinkingTransferPolicy(kimi)).toBe("re-signed");
  });

  it("re-signs when the source model is unknown", () => {
    expect(
      thinkingTransferPolicy({
        target: { provider: "neuralwatt", modelId: "kimi-k3", api: "openai-completions", reasoning: true },
      }),
    ).toBe("re-signed");
  });

  it("strips for signature-sensitive anthropic targets", () => {
    expect(
      thinkingTransferPolicy({
        source: codexSource,
        target: { provider: "anthropic", modelId: "claude", api: "anthropic-messages", reasoning: true },
      }),
    ).toBe("stripped");
  });

  it("strips for non-reasoning openai-completions targets", () => {
    expect(
      thinkingTransferPolicy({
        source: codexSource,
        target: { provider: "x", modelId: "m", api: "openai-completions", reasoning: false },
      }),
    ).toBe("stripped");
  });

  it("strips for targets that force thinking into visible text", () => {
    expect(
      thinkingTransferPolicy({
        source: codexSource,
        target: {
          provider: "x",
          modelId: "m",
          api: "openai-completions",
          reasoning: true,
          requiresThinkingAsText: true,
        },
      }),
    ).toBe("stripped");
  });
});

describe("thinking transfer translation", () => {
  const branch = (): SessionEntry[] => [
    user("u1", "Implement the guard"),
    assistant("a1", [
      { type: "thinking", thinking: "**Plan the token guard**\n\ndeliberation", thinkingSignature: CODEX_BLOB },
      { type: "thinking", thinking: "   \n  " },
      { type: "thinking", thinking: "opaque", thinkingSignature: "zGF0YQ==", redacted: true },
      { type: "text", text: "I will edit src/token.ts." },
      {
        type: "toolCall",
        id: "call-1",
        name: "edit",
        arguments: { path: "src/token.ts" },
        thoughtSignature: '{"sig":"google-blob"}',
      },
    ]),
  ];

  it("returns the input untouched for preserved handoffs", () => {
    const entries = branch();
    const result = translateThinkingForExecutor(entries, "preserved");
    expect(result.entries).toBe(entries);
    expect(result.report).toEqual({ policy: "preserved", translated: 0, dropped: 0 });
  });

  it("re-signs textual thinking and drops opaque blocks for reasoning_content targets", () => {
    const source = branch();
    const result = translateThinkingForExecutor(source, "re-signed");
    const message = (result.entries[1] as unknown as SessionMessageEntry).message as unknown as {
      content: Array<Record<string, unknown>>;
    };
    const parts = message.content;
    const thinking = parts.filter((part) => part.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      thinking: "**Plan the token guard**\n\ndeliberation",
      thinkingSignature: REASONING_CONTENT_SIGNATURE,
    });
    const toolCall = parts.find((part) => part.type === "toolCall");
    expect(toolCall).not.toHaveProperty("thoughtSignature");
    expect(parts.find((part) => part.type === "text")).toMatchObject({ text: "I will edit src/token.ts." });
    expect(result.report).toEqual({ policy: "re-signed", translated: 1, dropped: 2 });
    // The input is cloned, never mutated.
    const original = (source[1] as unknown as SessionMessageEntry).message as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(original.content[0]).toMatchObject({ thinkingSignature: CODEX_BLOB });
    expect(original.content.find((part) => part.type === "toolCall")).toHaveProperty("thoughtSignature");
  });

  it("strips every thinking part and foreign thought signature", () => {
    const result = translateThinkingForExecutor(branch(), "stripped");
    const message = (result.entries[1] as unknown as SessionMessageEntry).message as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(message.content.some((part) => part.type === "thinking")).toBe(false);
    expect(
      message.content.find((part) => part.type === "toolCall"),
    ).not.toHaveProperty("thoughtSignature");
    expect(message.content).toHaveLength(2);
    expect(result.report).toEqual({ policy: "stripped", translated: 0, dropped: 3 });
  });
});

describe("thinking continuity digest", () => {
  it("returns undefined without thinking blocks", () => {
    expect(buildThinkingDigest([user("u1", "goal")], kimi)).toBeUndefined();
  });

  it("cites the most recent bounded thinking lines with their entry ids", () => {
    const entries = [user("u1", "goal")];
    for (let index = 0; index < 12; index += 1) {
      entries.push(
        assistant(`a${index}`, [
          { type: "thinking", thinking: `Plan step ${index} of the refactor\nmore text` },
        ]),
      );
    }
    const digest = buildThinkingDigest(entries, kimi);
    expect(digest).toBeDefined();
    expect(digest!.citedBlocks).toBe(8);
    expect(digest!.content).toContain("[entry a11] Plan step 11");
    expect(digest!.content).toContain("[entry a4] Plan step 4");
    expect(digest!.content).not.toContain("[entry a3]");
    expect(digest!.content).toContain("omitted 4 older thinking blocks");
    expect(digest!.content).toContain("openai-codex/gpt-5.6-sol");
    expect(digest!.content).toContain("neuralwatt/kimi-k3");
    expect(digest!.content).toContain("deliberation, not commitments");
    expect(Buffer.byteLength(digest!.content, "utf8")).toBeLessThanOrEqual(2048);
  });
});
