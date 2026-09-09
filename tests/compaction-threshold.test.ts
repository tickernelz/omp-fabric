import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/compaction/hook.js";
import { LcmRuntime } from "../src/compaction/lcm-runtime.js";
import { compactAtConfiguredThreshold, modelCompactionKey } from "../src/compaction/threshold.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { closeAfterTest, releaseTemp, tempRoot } from "./fixtures/lcm-temp.js";

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


  it("falls back to the hard threshold only for models without their own entry", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.hardThresholdRatio = 0.75;
    const reached = contextWithUsage(80);
    await expect(compactAtConfiguredThreshold(reached, config)).resolves.toBe(true);

    const below = contextWithUsage(70);
    await expect(compactAtConfiguredThreshold(below, config)).resolves.toBe(false);
    expect(below.compact).not.toHaveBeenCalled();

    config.compaction.thresholds["anthropic/sonnet"] = 0.9;
    const overridden = contextWithUsage(80);
    await expect(compactAtConfiguredThreshold(overridden, config)).resolves.toBe(false);
    expect(overridden.compact).not.toHaveBeenCalled();
  });

  it("leaves the trigger to the host when the hard threshold is disabled", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    expect(config.compaction.hardThresholdRatio).toBe(0);
    const context = contextWithUsage(99);
    await expect(compactAtConfiguredThreshold(context, config)).resolves.toBe(false);
    expect(context.compact).not.toHaveBeenCalled();
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

describe("maintenance occupancy gate", () => {
  const usageContext = (root: string, percent: number): ExtensionContext => ({
    cwd: root,
    model: undefined,
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    getContextUsage: () => ({ tokens: percent * 1_000, contextWindow: 100_000, percent }),
    sessionManager: {
      getRecordedCwd: () => root,
      getSessionFile: () => undefined,
      getSessionId: () => "session-1",
      getLeafId: () => "branch-a",
      getBranch: () => [],
    },
  } as unknown as ExtensionContext);

  const openRuntime = (root: string, softThresholdRatio: number): LcmRuntime =>
    closeAfterTest(
      new LcmRuntime(usageContext(root, 5), { rootDir: root, softThresholdRatio }),
      (runtime) => runtime.shutdown(),
    );

  afterEach(releaseTemp);

  it("runs maintenance at any occupancy when the configured ratio is zero", async () => {
    const ratio = normalizeFabricConfig({ compaction: { softThresholdRatio: 0 } })
      .compaction.softThresholdRatio;
    expect(ratio).toBe(0);

    const root = tempRoot("lcm-soft-off-");
    expect(openRuntime(root, ratio).maintenanceOccupancyReached()).toBe(true);
  });

  it("still gates maintenance below a configured ratio", async () => {
    const ratio = normalizeFabricConfig({ compaction: { softThresholdRatio: 0.55 } })
      .compaction.softThresholdRatio;
    expect(ratio).toBe(0.55);

    const root = tempRoot("lcm-soft-on-");
    expect(openRuntime(root, ratio).maintenanceOccupancyReached()).toBe(false);
  });
});

describe("compaction documentation", () => {
  const compactionDoc = (): string => readFileSync("docs/compaction.md", "utf8");

  it("describes what summary expansion actually returns", () => {
    const doc = compactionDoc();

    expect(doc).toContain(
      "Summary expansion descends one level: it returns the constituent messages the summary was built from, each with its own address and a \`memory.expand\` follow-up, or the child nodes of a condensed node. The node's own text, kind, state, sources, and children sit in a top-level \`node\` field.",
    );
    expect(doc).not.toContain(
      "Summary expansion returns the summary text and its structured source references.",
    );
  });

  it("documents the zero-is-off convention shared by both occupancy ratios", () => {
    expect(compactionDoc()).toContain("both ratio keys use the same \`0\`-is-off convention");
  });
});
