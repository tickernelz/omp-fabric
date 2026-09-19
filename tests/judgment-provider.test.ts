import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricJudgmentLane } from "../src/judgment/lane.js";
import { JudgmentProvider } from "../src/providers/judgment-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
} as unknown as FabricInvocationContext;

const judge: Judge = {
  label: "test/judge",
  async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
    const answers: Record<string, unknown> = {};
    for (const id in request.questions) answers[id] = { type: "noul", noul: 0.42 };
    return {
      api: "test",
      provider: "test",
      model: "fake-1",
      answers: answers as JudgmentResult<Q>["answers"],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
  },
};

const provider = (judgeImpl: Judge | undefined): JudgmentProvider =>
  new JudgmentProvider(
    new FabricJudgmentLane({ ...DEFAULT_FABRIC_CONFIG.judgment, coalesceMs: 1 }, async () => judgeImpl),
  );

describe("JudgmentProvider", () => {
  it("renders a yes/no answer as bool for calling code", async () => {
    const result = await provider(judge).invoke(
      "ask",
      { state: "the turn", questions: { urgent: { type: "bool", instructions: "urgent?" } } },
      context,
    ) as { ok: boolean; backend: string; answers: Record<string, unknown> };

    expect(result.ok).toBe(true);
    expect(result.backend).toBe("test/fake-1");
    expect(result.answers.urgent).toEqual({ type: "bool", bool: 0.42 });
  });

  it("rejects a choice question with fewer than two options", async () => {
    await expect(provider(judge).invoke(
      "ask",
      {
        state: "the turn",
        questions: { route: { type: "choice", instructions: "who?", criteria: { only: null } } },
      },
      context,
    )).rejects.toThrow("at least two options");
  });

  it("rejects an unknown question type", async () => {
    await expect(provider(judge).invoke(
      "ask",
      { state: "the turn", questions: { x: { type: "ranking", instructions: "rank" } } },
      context,
    )).rejects.toThrow('must be "choice", "bool", or "score"');
  });

  it("returns the refusal reason instead of throwing when no backend exists", async () => {
    const result = await provider(undefined).invoke(
      "ask",
      { state: "the turn", questions: { urgent: { type: "bool", instructions: "urgent?" } } },
      context,
    );

    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports lane counters", async () => {
    const instance = provider(judge);
    await instance.invoke(
      "ask",
      { state: "the turn", questions: { urgent: { type: "bool", instructions: "urgent?" } } },
      context,
    );
    const stats = await instance.invoke("stats", {}, context) as { enabled: boolean; requests: number };

    expect(stats.enabled).toBe(true);
    expect(stats.requests).toBe(1);
  });
});
