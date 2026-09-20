import { describe, expect, it } from "vitest";
import type { FabricJudgmentLane } from "../src/judgment/lane.js";
import { skillSuggestionBlock, suggestSkill } from "../src/judgment/gates/skills.js";

interface Recorded {
  state: unknown;
  questions: Record<string, unknown>;
}

const roster = [
  { name: "ship-release", description: "Cut and verify a tagged npm release." },
  { name: "debug-flake", description: "Diagnose a test that passes alone and fails in a suite." },
  { name: "write-docs", description: "Write a developer guide from working code." },
  { name: "prune-disk", description: "Reclaim disk safely on a dev box." },
];

const laneFor = (
  answers: Array<Record<string, unknown>>,
  recorded: Recorded[] = [],
): FabricJudgmentLane => ({
  ask: async (state: unknown, questions: Record<string, unknown>) => {
    recorded.push({ state, questions });
    const next = answers.shift();
    if (!next) return { ok: false, reason: "failed", detail: "no scripted answer" };
    return { ok: true, backend: "test/fake-1", answers: next };
  },
} as unknown as FabricJudgmentLane);

const needsSkill = {
  acts_on_their_work: { type: "noul", noul: 0.9 },
  follows_a_procedure: { type: "noul", noul: 0.9 },
  conversation_only: { type: "noul", noul: 0.1 },
};

const ranked = (probabilities: Record<string, number>, choice = "ship-release") => ({
  ...needsSkill,
  pick_0: { type: "choice", choice, probabilities, confidence: 0.8 },
});

describe("suggestSkill", () => {
  it("names the skill both passes agree on", async () => {
    const recorded: Recorded[] = [];
    const lane = laneFor([
      ranked({ "ship-release": 0.7, "debug-flake": 0.2, "write-docs": 0.05, "prune-disk": 0.05 }),
      {
        pick: { type: "choice", choice: "ship-release", probabilities: { "ship-release": 0.9 }, confidence: 0.9 },
        fits_ship_release: { type: "noul", noul: 0.88 },
      },
    ], recorded);

    const suggestion = await suggestSkill(lane, "cut the 1.21.0 release and verify it", roster);

    expect(suggestion?.name).toBe("ship-release");
    expect(recorded).toHaveLength(2);
    expect(Object.keys(recorded[0]!.questions)).toContain("pick_0");
  });

  it("stays silent on a turn that needs no skill", async () => {
    const recorded: Recorded[] = [];
    const lane = laneFor([
      {
        acts_on_their_work: { type: "noul", noul: 0.05 },
        follows_a_procedure: { type: "noul", noul: 0.05 },
        conversation_only: { type: "noul", noul: 0.95 },
        pick_0: { type: "choice", choice: "write-docs", probabilities: { "write-docs": 0.6 }, confidence: 0.6 },
      },
    ], recorded);

    expect(await suggestSkill(lane, "what does TCP stand for", roster)).toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  it("accepts the second pass rejecting all three", async () => {
    const lane = laneFor([
      ranked({ "ship-release": 0.4, "debug-flake": 0.3, "write-docs": 0.2, "prune-disk": 0.1 }),
      {
        pick: { type: "choice", choice: "__none__", probabilities: { __none__: 0.7 }, confidence: 0.7 },
        fits_ship_release: { type: "noul", noul: 0.2 },
      },
    ]);

    expect(await suggestSkill(lane, "do something else entirely", roster)).toBeUndefined();
  });

  it("drops a winner the second pass does not believe in", async () => {
    const lane = laneFor([
      ranked({ "ship-release": 0.5, "debug-flake": 0.3, "write-docs": 0.1, "prune-disk": 0.1 }),
      {
        pick: { type: "choice", choice: "ship-release", probabilities: { "ship-release": 0.5 }, confidence: 0.5 },
        fits_ship_release: { type: "noul", noul: 0.1 },
      },
    ]);

    expect(await suggestSkill(lane, "ship it", roster)).toBeUndefined();
  });

  it("carries only the three best candidates into the second pass", async () => {
    const recorded: Recorded[] = [];
    const lane = laneFor([
      ranked({ "ship-release": 0.4, "debug-flake": 0.3, "write-docs": 0.2, "prune-disk": 0.1 }),
      {
        pick: { type: "choice", choice: "ship-release", probabilities: { "ship-release": 0.9 }, confidence: 0.9 },
        fits_ship_release: { type: "noul", noul: 0.9 },
      },
    ], recorded);

    await suggestSkill(lane, "release time", roster);

    const second = recorded[1]!.state as { candidates: Record<string, string> };
    expect(Object.keys(second.candidates).sort()).toEqual(
      ["__none__", "debug-flake", "ship-release", "write-docs"],
    );
  });

  it("says nothing when the lane refuses", async () => {
    const lane = { ask: async () => ({ ok: false, reason: "unsupported" }) } as unknown as FabricJudgmentLane;

    expect(await suggestSkill(lane, "cut the release", roster)).toBeUndefined();
  });

  it("splits a roster past the choice cap and keeps every skill in play", async () => {
    const recorded: Recorded[] = [];
    const lane = laneFor([], recorded);
    const wide = Array.from({ length: 400 }, (_value, index) => ({
      name: `skill-${index}`,
      description: "d".repeat(200),
    }));

    await suggestSkill(lane, "anything", wide);

    const asked = recorded[0]!.questions as Record<string, { criteria?: Record<string, string> }>;
    const picks = Object.keys(asked).filter((id) => id.startsWith("pick_"));
    expect(picks.length).toBeGreaterThan(1);
    for (const id of picks) {
      const criteria = asked[id]!.criteria!;
      expect(Object.keys(criteria).length).toBeLessThanOrEqual(255);
      expect(Buffer.byteLength(JSON.stringify(criteria), "utf-8")).toBeLessThanOrEqual(48 * 1024);
    }
    expect(picks.flatMap((id) => Object.keys(asked[id]!.criteria!)).filter((name) => name !== "__none__"))
      .toHaveLength(400);
  });

  it("keeps the roster and the model's own judgment intact in the injected line", () => {
    const block = skillSuggestionBlock({ name: "ship-release", probability: 0.9, confidence: 0.9 });

    expect(block).toContain("ship-release");
    expect(block).toContain("Ignore this if it does not fit");
  });
});
