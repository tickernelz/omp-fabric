import { describe, expect, it } from "vitest";
import {
  isSpeculationEligible,
  mcpAllowlistMatch,
  TIER_A_SPECULATION_REFS,
  type SpeculationActionView,
} from "../src/speculation/eligibility.js";

const view = (overrides: Partial<SpeculationActionView>): SpeculationActionView => ({
  ref: "demo.x",
  provider: "demo",
  risk: "read",
  effectKind: "none",
  ...overrides,
});

describe("speculation eligibility", () => {
  it("admits Tier-A reads with none effects", () => {
    expect(
      isSpeculationEligible(
        view({ ref: "omp.read", provider: "omp" }),
        [],
      ),
    ).toBe(true);
    expect(TIER_A_SPECULATION_REFS.has("compact.cancel")).toBe(false);
  });

  it("refuses Tier-A refs whose descriptor drifted from the read contract", () => {
    expect(
      isSpeculationEligible(view({ ref: "omp.read", provider: "omp", risk: "execute" }), []),
    ).toBe(false);
    expect(
      isSpeculationEligible(view({ ref: "omp.read", provider: "omp", effectKind: "emission" }), []),
    ).toBe(false);
  });

  it("refuses non-tier refs without an MCP allowlist", () => {
    expect(isSpeculationEligible(view({ ref: "state.transition", provider: "state", risk: "write" }), [])).toBe(false);
    expect(
      isSpeculationEligible(
        view({ ref: "mcp.exa.search", provider: "mcp", risk: "network" }),
        [],
      ),
    ).toBe(false);
  });

  it("admits allowlisted MCP tools and honors annotation precedence", () => {
    const allowlist = ["exa.*", "github.get_file"];
    expect(
      isSpeculationEligible(
        view({ ref: "mcp.exa.search", provider: "mcp", risk: "network" }),
        allowlist,
      ),
    ).toBe(true);
    expect(
      isSpeculationEligible(
        view({ ref: "mcp.github.get_file", provider: "mcp", risk: "network" }),
        allowlist,
      ),
    ).toBe(true);
    // Not allowlisted.
    expect(
      isSpeculationEligible(
        view({ ref: "mcp.github.create_issue", provider: "mcp", risk: "network" }),
        allowlist,
      ),
    ).toBe(false);
    // Explicit destructive hint refuses despite the wildcard.
    expect(
      isSpeculationEligible(
        view({
          ref: "mcp.exa.search",
          provider: "mcp",
          risk: "network",
          annotations: { destructiveHint: true },
        }),
        allowlist,
      ),
    ).toBe(false);
    // readOnlyHint:false refuses; absent annotations defer to the allowlist.
    expect(
      isSpeculationEligible(
        view({
          ref: "mcp.exa.search",
          provider: "mcp",
          risk: "network",
          annotations: { readOnlyHint: false },
        }),
        allowlist,
      ),
    ).toBe(false);
  });

  it("matches allowlist patterns exactly", () => {
    expect(mcpAllowlistMatch("exa.search", ["exa.*"])).toBe(true);
    expect(mcpAllowlistMatch("exa", ["exa.*"])).toBe(false);
    expect(mcpAllowlistMatch("example.search", ["exa.*"])).toBe(false);
    expect(mcpAllowlistMatch("github.get_file", ["github.get_file"])).toBe(true);
    expect(mcpAllowlistMatch("github.get_file_contents", ["github.get_file"])).toBe(false);
  });
});
