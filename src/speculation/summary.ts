import type { FabricSpeculationSummaryV1 } from "../audit/details.js";
import type { FabricSpeculationStats } from "./types.js";

export const fabricSpeculationSummary = (
  stats: FabricSpeculationStats | undefined,
): FabricSpeculationSummaryV1 | undefined => {
  if (!stats) return undefined;
  const summary: FabricSpeculationSummaryV1 = {
    launched: stats.launched,
    hit: stats.served,
    missed:
      stats.absent + stats.epochInvalidated + stats.freshnessInvalidated + stats.failed,
    discarded: stats.wasted + stats.skipped,
  };
  return summary.launched === 0 && summary.missed === 0 ? undefined : summary;
};
