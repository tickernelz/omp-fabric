import type { FabricSpeculationConfig } from "../config.js";
import type { FabricMediaBlock } from "../protocol.js";

// Config shape lives with the other Fabric config sections in ../config.ts;
// re-exported here so the speculation package keeps a local import surface.
export type { FabricSpeculationConfig };


/** One literal-argument call discovered in the partially streamed program. */
export interface FabricSpeculationCandidate {
  ref: string;
  args: Record<string, unknown>;
}

/** Side-channel outputs captured during a speculative provider invoke, replayed into the real audit when served. */
export interface FabricSpeculationReplay {
  media?: FabricMediaBlock[];
  mediaNote?: string;
  updatedArgs?: Record<string, unknown>;
  preview?: unknown;
}

export interface FabricSpeculationStats {
  launched: number;
  served: number;
  absent: number;
  epochInvalidated: number;
  freshnessInvalidated: number;
  failed: number;
  wasted: number;
  skipped: number;
}

export type FabricSpeculationServeResult =
  | { hit: true; value: unknown; replay: FabricSpeculationReplay }
  | { hit: false; reason: "absent" | "epoch" | "freshness" | "failed" };

/**
 * Host-side store consumed by ActionRegistry.invoke. Implemented by
 * FabricSpeculationStore; declared structurally so the registry never imports
 * the speculation package.
 */
export interface FabricSpeculationRuntime {
  tryServe(
    parentToolCallId: string,
    ref: string,
    preparedArgs: Record<string, unknown>,
    bindingToken: string,
  ): Promise<FabricSpeculationServeResult>;
  bumpEpoch(): void;
  stats?(): FabricSpeculationStats;
  beginLaunch?(parentToolCallId: string): () => void;
  settleLaunches?(parentToolCallId: string, timeoutMs: number): Promise<void>;
  reset?(): void;
  onInvocationEnd?(parentToolCallId: string): void;
}
