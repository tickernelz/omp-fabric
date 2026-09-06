import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/compaction/hook.js";
import { compactAtConfiguredThreshold, modelCompactionKey } from "../src/compaction/threshold.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const contextWithUsage = (percent: number | null): ExtensionContext => ({
  model: { provider: "anthropic", id: "sonnet" },
  getContextUsage: () => ({ tokens: percent === null ? null : percent * 1_000, contextWindow: 100_000, percent }),
  compact: vi.fn((options) => options?.onComplete?.({} as never)),
  hasUI: true,
  ui: { notify: vi.fn() },
} as unknown as ExtensionContext);

describe("model-linked compaction thresholds", () => {
  it("builds canonical provider/model keys", () => {
    expect(modelCompactionKey({ provider: "openai", id: "gpt-5" } as never)).toBe("openai/gpt-5");
    expect(modelCompactionKey(undefined)).toBeUndefined();
  });

  it("compacts when the active model reaches its configured threshold", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.8;
    const context = contextWithUsage(80);

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(context.compact).toHaveBeenCalledOnce();
  });


  it("compacts when token usage reaches a configured token threshold", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.tokenThresholds["anthropic/sonnet"] = 50_000;
    const context = contextWithUsage(80); // 80,000 of 100,000 tokens

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(true);
    expect(context.compact).toHaveBeenCalledOnce();
  });

  it("lets token thresholds win over ratios and skips unknown token usage", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.25;
    config.compaction.tokenThresholds["anthropic/sonnet"] = 900_000;
    const context = contextWithUsage(80); // 80,000 tokens: ratio exceeded, token threshold not

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).not.toHaveBeenCalled();

    const unknown = contextWithUsage(null); // tokens unknown right after compaction
    await expect(compactAtConfiguredThreshold(unknown, config)).resolves.toBe(false);
    expect(unknown.compact).not.toHaveBeenCalled();
  });


  it("does not compact below threshold or for an unconfigured model", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.85;
    const context = contextWithUsage(80);

    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).not.toHaveBeenCalled();

    config.compaction.thresholds = {};
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).not.toHaveBeenCalled();
  });
});
