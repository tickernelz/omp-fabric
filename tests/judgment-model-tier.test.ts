import type { Answer, Judge, JudgmentRequest, JudgmentResult, Question, Questions } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "vitest";
import { judgeDelegation } from "../src/judgment/gates/delegation.js";
import { FabricJudgmentLane } from "../src/judgment/lane.js";

interface ScriptedTier {
  choice: string;
  confidence: number;
  omit?: boolean;
}

const scriptedLane = (tier: ScriptedTier, seen: JudgmentRequest[] = []): FabricJudgmentLane => {
  const judge: Judge = {
    label: "test/model-tier",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      seen.push(request);
      const out: Record<string, Answer> = {};
      if (!tier.omit) {
        for (const id in request.questions) {
          const question = request.questions[id]!;
          if (question.type !== "choice") continue;
          const labels = Object.keys(question.criteria);
          const probabilities: Record<string, number> = {};
          for (const label of labels) probabilities[label] = label === tier.choice ? 1 : 0;
          out[id] = {
            type: "choice",
            choice: tier.choice,
            probabilities,
            confidence: tier.confidence,
          };
        }
      }
      return {
        api: "test",
        provider: "test",
        model: "model-tier-script",
        answers: out as JudgmentResult<Q>["answers"],
        usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    },
  };
  return new FabricJudgmentLane(
    {
      enabled: true,
      coalesceMs: 1,
      timeoutMs: 2_000,
      maxConcurrent: 1,
      maxQuestionsPerRequest: 8,
      maxStateBytes: 4096,
      gates: { delegation: false, toolExec: false, toolOutput: false, skills: false },
    },
    async () => judge,
  );
};

const tierInput = () => ({
  task: "Decide the model tier for a delegated run",
  cwd: process.cwd(),
  candidates: [{ kind: "omp" as const, tools: ["read"] }],
  needRunner: false,
  needThinking: false,
  needModelTier: true,
});

describe("judgeDelegation model tier", () => {
  it.each([
    { choice: "quick", confidence: 0.7, expected: "@smol" },
    { choice: "medium", confidence: 0.7, expected: "@default" },
    { choice: "heavy", confidence: 0.7, expected: "@slow" },
    { choice: "heavy", confidence: 0.69, expected: undefined },
    { choice: "enormous", confidence: 0.95, expected: undefined },
  ])("maps $choice at confidence $confidence to $expected", async ({ choice, confidence, expected }) => {
    const lane = scriptedLane({ choice, confidence });
    const decision = await judgeDelegation(lane, tierInput());
    expect(decision).toEqual(expected === undefined ? undefined : { model: expected });
  });

  it("asks one choice question over the three tiers with the run state", async () => {
    const seen: JudgmentRequest[] = [];
    const lane = scriptedLane({ choice: "quick", confidence: 0.7 }, seen);
    await judgeDelegation(lane, tierInput());

    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    const questions = request.questions as Questions;
    const questionId = Object.keys(questions).find((id) => id.endsWith("modelTier"));
    const question = questionId ? (questions[questionId] as Question) : undefined;
    expect(question?.type).toBe("choice");
    if (question?.type === "choice") {
      expect(Object.keys(question.criteria)).toEqual(["quick", "medium", "heavy"]);
    }
    const state = request.state as {
      task: string;
      cwd: string;
      agentKinds: Array<{ kind: string; tools: string[] }>;
    };
    expect(state.task).toBe("Decide the model tier for a delegated run");
    expect(state.cwd).toBe(process.cwd());
    expect(state.agentKinds).toEqual([{ kind: "omp", tools: ["read"] }]);
  });

  it("keeps ordinary routing when the lane omits the tier answer", async () => {
    const absent = scriptedLane({ choice: "quick", confidence: 0.95, omit: true });
    await expect(judgeDelegation(absent, tierInput())).resolves.toBeUndefined();
  });
});
