import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { FabricConfig } from "../config.js";

export const modelCompactionKey = (
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined,
): string | undefined => model ? `${model.provider}/${model.id}` : undefined;

// A configured token threshold takes precedence over a ratio for the same
// model; the settings UI keeps the maps mutually exclusive, and hand-written
// configs resolve to the more explicit token value.
const configuredCompactionTokenThreshold = (
  config: FabricConfig,
  modelKey: string | undefined,
): number | undefined =>
  modelKey === undefined ? undefined : config.compaction.tokenThresholds[modelKey];

const configuredCompactionThreshold = (
  config: FabricConfig,
  modelKey: string | undefined,
): number | undefined =>
  modelKey === undefined ? undefined : config.compaction.thresholds[modelKey];

const runThresholdCompact = async (context: ExtensionContext): Promise<boolean> => {
  try {
    await context.compact();
    return true;
  } catch (error) {
    if (context.hasUI) {
      context.ui.notify(`Fabric threshold compaction failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return false;
  }
};

export const compactAtConfiguredThreshold = async (
  context: ExtensionContext,
  config: FabricConfig,
): Promise<boolean> => {
  const modelKey = modelCompactionKey(context.model);
  const usage = context.getContextUsage();
  if (usage === undefined) return false;

  const tokenThreshold = configuredCompactionTokenThreshold(config, modelKey);
  if (tokenThreshold !== undefined) {
    if (usage.tokens === null || usage.tokens < tokenThreshold) return false;
    return runThresholdCompact(context);
  }

  const threshold = configuredCompactionThreshold(config, modelKey)
    ?? (config.compaction.hardThresholdRatio > 0 ? config.compaction.hardThresholdRatio : undefined);
  if (threshold === undefined || usage.percent === null) return false;
  if (usage.percent / 100 < threshold) return false;

  return runThresholdCompact(context);
};
