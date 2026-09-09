import { describe, expect, it } from "vitest";
import {
  lcmRawAddress,
  lcmSummaryAddress,
  renderLcmChildAddresses,
  renderLcmSourceAddresses,
} from "../../src/compaction/lcm-addresses.js";
import { utf8Bytes } from "../../src/compaction/bounds.js";

const source = (entryId: string, revision = 1) => ({ sessionId: "s1", entryId, revision });

describe("LCM addresses", () => {
  it("renders addresses memory.expand can parse back", () => {
    expect(lcmRawAddress(source("e1", 3))).toBe("lcm.raw:s1:e1:3");
    expect(lcmSummaryAddress("node-7")).toBe("lcm.summary:node-7");
  });

  it("returns nothing when there is no room or nothing to address", () => {
    expect(renderLcmSourceAddresses([source("e1")], 0)).toBe("");
    expect(renderLcmSourceAddresses([source("e1")], -5)).toBe("");
    expect(renderLcmSourceAddresses([], 4_096)).toBe("");
    expect(renderLcmSourceAddresses([source("e1")], 8)).toBe("");
  });

  it("lists every source when the budget allows", () => {
    const rendered = renderLcmSourceAddresses([source("e1"), source("e2", 2)], 4_096);
    expect(rendered).toBe("sources: lcm.raw:s1:e1:1, lcm.raw:s1:e2:2");
  });

  it("marks the omitted remainder and stays inside the budget", () => {
    const sources = Array.from({ length: 40 }, (_, index) => source(`entry-${index}`));
    const full = renderLcmSourceAddresses(sources, 4_096);
    const budget = utf8Bytes(full) - 40;
    const clipped = renderLcmSourceAddresses(sources, budget);
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(budget);
    expect(clipped).toMatch(/, \+\d+ more$/);
    const kept = clipped.slice("sources: ".length).split(", ").filter((part) => part.startsWith("lcm.raw:"));
    const omitted = Number(/\+(\d+) more$/.exec(clipped)?.[1]);
    expect(kept.length + omitted).toBe(sources.length);
  });

  it("addresses condensed children as summaries", () => {
    expect(renderLcmChildAddresses(["a", "b"], 4_096)).toBe("children: lcm.summary:a, lcm.summary:b");
    expect(renderLcmChildAddresses([], 4_096)).toBe("");
  });
});
