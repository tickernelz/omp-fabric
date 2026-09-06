import type { FabricRisk } from "../protocol.js";

// Tier A: refs whose speculation is guaranteed correct under the epoch +
// freshness rules in ./store.ts. Every entry is risk "read" with a declared
// none effect, never prompts for approval, has no in-guest writer with
// invisible effects, and costs nothing measurable when a speculation is
// wasted. `compact.cancel` is deliberately absent: it is a control action
// mislabeled "read" until it was reclassified "write" — keep it out forever.
export const TIER_A_SPECULATION_REFS: ReadonlySet<string> = new Set([
  "omp.read",
  "omp.grep",
  "omp.find",
  "omp.ls",
  "memory.recall",
  "memory.expand",
  "memory.sessions",
  "state.get",
  "state.history",
  "state.complexity",
  "schema.status",
  "compact.status",
  "components.list",
  "components.status",
  "components.graph",
]);

export interface SpeculationActionView {
  ref: string;
  provider: string;
  risk: FabricRisk;
  effectKind: string | undefined;
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Match `server.tool` / `server.*` allowlist patterns against an MCP ref tail. */
export const mcpAllowlistMatch = (
  refWithoutProvider: string,
  allowlist: readonly string[],
): boolean => {
  for (const pattern of allowlist) {
    if (pattern.endsWith(".*")) {
      if (refWithoutProvider.startsWith(`${pattern.slice(0, -2)}.`)) return true;
    } else if (pattern === refWithoutProvider) {
      return true;
    }
  }
  return false;
};

/**
 * Static per-ref gate used both by the stream tap (cheap) and by
 * ActionRegistry.speculate (authoritative, post-descriptor-resolution).
 */
export const isSpeculationEligible = (
  action: SpeculationActionView,
  mcpAllowlist: readonly string[],
): boolean => {
  if (TIER_A_SPECULATION_REFS.has(action.ref)) {
    return action.risk === "read" && action.effectKind === "none";
  }
  if (action.provider !== "mcp" || action.risk !== "network") return false;
  if (mcpAllowlist.length === 0) return false;
  if (!mcpAllowlistMatch(action.ref.slice("mcp.".length), mcpAllowlist)) return false;
  // Annotations trump the allowlist only when present: an explicit destructive
  // hint refuses even an allowlisted tool, while absent annotations defer to
  // the operator's assertion that the tool is read-only.
  if (action.annotations?.destructiveHint === true) return false;
  if (action.annotations && action.annotations.readOnlyHint === false) return false;
  return true;
};
