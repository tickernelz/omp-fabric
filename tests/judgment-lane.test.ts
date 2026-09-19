import type { Answer, Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG, type FabricJudgmentConfig } from "../src/config.js";
import { FabricJudgmentLane } from "../src/judgment/lane.js";

const config = (overrides: Partial<FabricJudgmentConfig> = {}): FabricJudgmentConfig => ({
  ...DEFAULT_FABRIC_CONFIG.judgment,
  coalesceMs: 5,
  timeoutMs: 100,
  ...overrides,
});

interface RecordingJudge extends Judge {
  requests: JudgmentRequest[];
}

const answerFor = (question: Questions[string]): Answer => {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: 0.75 };
    case "score":
      return { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.8 };
    default: {
      const labels = Object.keys(question.criteria);
      const probabilities: Record<string, number> = {};
      for (const label of labels) probabilities[label] = label === labels[0] ? 0.9 : 0.1;
      return { type: "choice", choice: labels[0]!, probabilities, confidence: 0.9 };
    }
  }
};

const recordingJudge = (behaviour?: { fail?: Error; hang?: boolean; omit?: string }): RecordingJudge => {
  const requests: JudgmentRequest[] = [];
  return {
    label: "test/judge",
    requests,
    async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: { signal?: AbortSignal }): Promise<JudgmentResult<Q>> {
      requests.push(request);
      if (behaviour?.fail) throw behaviour.fail;
      if (behaviour?.hang) {
        return await new Promise<JudgmentResult<Q>>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const answers: Record<string, Answer> = {};
      for (const id in request.questions) {
        if (id.endsWith(behaviour?.omit ?? "\u0000never")) continue;
        answers[id] = answerFor(request.questions[id]!);
      }
      return {
        api: "test",
        provider: "test",
        model: "fake-1",
        answers: answers as JudgmentResult<Q>["answers"],
        usage: tokenUsage(10, 5),
      };
    },
  };
};


const concurrencyJudge = (): { judge: Judge; peak: () => number } => {
  let live = 0;
  let peak = 0;
  return {
    peak: () => peak,
    judge: {
      label: "test/slow",
      async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
        live++;
        peak = Math.max(peak, live);
        await new Promise((settle) => setTimeout(settle, 10));
        live--;
        const answers: Record<string, Answer> = {};
        for (const id in request.questions) answers[id] = { type: "noul", noul: 0.5 };
        return {
          api: "test",
          provider: "test",
          model: "fake-1",
          answers: answers as JudgmentResult<Q>["answers"],
          usage: tokenUsage(1, 1),
        };
      },
    },
  };
};

describe("FabricJudgmentLane", () => {
  it("merges same-state questions from separate callers into one request", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config(), async () => judge);
    const state = { turn: "deploy failed" };

    const [first, second] = await Promise.all([
      lane.ask(state, { urgent: { type: "noul", instructions: "Is this urgent?" } }),
      lane.ask(state, {
        route: {
          type: "choice",
          instructions: "Who handles it?",
          criteria: { scout: "investigate", task: "implement" },
        },
      }),
    ]);

    expect(judge.requests).toHaveLength(1);
    expect(Object.keys(judge.requests[0]!.questions)).toHaveLength(2);
    expect(first.ok && Object.keys(first.answers)).toEqual(["urgent"]);
    expect(second.ok && Object.keys(second.answers)).toEqual(["route"]);
    expect(first.ok && first.answers.urgent.type).toBe("noul");
    expect(lane.stats().batched).toBe(1);
  });

  it("keeps different states in separate requests", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config(), async () => judge);

    await Promise.all([
      lane.ask("first evidence", { a: { type: "noul", instructions: "yes?" } }),
      lane.ask("second evidence", { b: { type: "noul", instructions: "yes?" } }),
    ]);

    expect(judge.requests).toHaveLength(2);
    expect(judge.requests.map((request) => request.state)).toEqual([
      "first evidence",
      "second evidence",
    ]);
  });

  it("reports a backend failure instead of rejecting", async () => {
    const judge = recordingJudge({ fail: new Error("upstream 500") });
    const lane = new FabricJudgmentLane(config(), async () => judge);

    const outcome = await lane.ask("state", { a: { type: "noul", instructions: "yes?" } });

    expect(outcome).toEqual({ ok: false, reason: "failed", detail: "upstream 500" });
    expect(lane.stats().failures).toBe(1);
  });

  it("reports an unsupported host without calling a backend", async () => {
    const lane = new FabricJudgmentLane(config(), async () => undefined);

    const outcome = await lane.ask("state", { a: { type: "noul", instructions: "yes?" } });

    expect(outcome).toEqual({ ok: false, reason: "unsupported" });
    expect(lane.stats().requests).toBe(0);
  });

  it("refuses an oversized state rather than truncating the evidence", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config({ maxStateBytes: 64 }), async () => judge);

    const outcome = await lane.ask("x".repeat(65), { a: { type: "noul", instructions: "yes?" } });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("refused");
    expect(judge.requests).toHaveLength(0);
    expect(lane.stats().refusals).toBe(1);
  });

  it("flushes a pending batch early rather than letting it cross the question cap", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config({ maxQuestionsPerRequest: 3 }), async () => judge);
    const state = "shared";

    const [first, second] = await Promise.all([
      lane.ask(state, {
        a: { type: "noul", instructions: "a?" },
        b: { type: "noul", instructions: "b?" },
      }),
      lane.ask(state, {
        c: { type: "noul", instructions: "c?" },
        d: { type: "noul", instructions: "d?" },
      }),
    ]);

    expect(judge.requests.map((request) => Object.keys(request.questions).length)).toEqual([2, 2]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("shares one resolution across concurrent batches", async () => {
    const judge = recordingJudge();
    let resolverCalls = 0;
    const lane = new FabricJudgmentLane(config(), async () => {
      resolverCalls++;
      await new Promise((settle) => setTimeout(settle, 5));
      return judge;
    });

    await Promise.all([
      lane.ask("first", { a: { type: "noul", instructions: "a?" } }),
      lane.ask("second", { b: { type: "noul", instructions: "b?" } }),
    ]);

    expect(resolverCalls).toBe(1);
  });

  it("retries a failed resolution instead of stranding the session", async () => {
    const judge = recordingJudge();
    let attempt = 0;
    const lane = new FabricJudgmentLane(config(), async () => {
      attempt++;
      if (attempt === 1) throw new Error("registry not ready");
      return judge;
    });

    const first = await lane.ask("state", { a: { type: "noul", instructions: "a?" } });
    const second = await lane.ask("state", { a: { type: "noul", instructions: "a?" } });

    expect(first).toEqual({ ok: false, reason: "unsupported", detail: "registry not ready" });
    expect(second.ok).toBe(true);
  });

  it("bounds the backend requests it keeps in flight", async () => {
    const backend = concurrencyJudge();
    const lane = new FabricJudgmentLane(config({ maxConcurrent: 2 }), async () => backend.judge);

    const outcomes = await Promise.all(
      ["a", "b", "c", "d", "e"].map((state) =>
        lane.ask(state, { q: { type: "noul", instructions: "yes?" } }),
      ),
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(backend.peak()).toBe(2);
  });

  it("holds the slot for a batch chained off an answer", async () => {
    const backend = concurrencyJudge();
    const lane = new FabricJudgmentLane(
      config({ maxConcurrent: 1, maxQuestionsPerRequest: 1 }),
      async () => backend.judge,
    );
    const question = { q: { type: "noul", instructions: "yes?" } } as const;

    const chained = lane.ask("a", question).then(() => lane.ask("c", question));
    const parallel = lane.ask("b", question);
    await Promise.all([chained, parallel]);

    expect(backend.peak()).toBe(1);
  });

  it("does not pay for a queued batch whose callers all left", async () => {
    const backend = concurrencyJudge();
    const lane = new FabricJudgmentLane(
      config({ maxConcurrent: 1, coalesceMs: 1 }),
      async () => backend.judge,
    );
    const controller = new AbortController();
    const question = { q: { type: "noul", instructions: "yes?" } } as const;

    const held = lane.ask("holds-the-slot", question);
    await new Promise((settle) => setTimeout(settle, 5));
    const queued = lane.ask("queued", question, { signal: controller.signal });
    await new Promise((settle) => setTimeout(settle, 3));
    controller.abort();

    expect(await queued).toEqual({ ok: false, reason: "aborted" });
    expect((await held).ok).toBe(true);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(lane.stats().requests).toBe(1);
  });

  it("refuses a state it cannot serialize", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config(), async () => judge);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    const outcome = await lane.ask(cyclic as never, { a: { type: "noul", instructions: "a?" } });

    expect(outcome).toEqual({ ok: false, reason: "refused", detail: "state is not JSON-encodable" });
    expect(judge.requests).toHaveLength(0);
  });

  it("settles callers when the backend ignores the deadline", async () => {
    const judge: Judge = {
      label: "test/hung",
      judge: () => new Promise(() => {}),
    };
    const lane = new FabricJudgmentLane(config({ timeoutMs: 20 }), async () => judge);

    const outcome = await lane.ask("state", { a: { type: "noul", instructions: "yes?" } });

    expect(outcome.ok === false && outcome.reason).toBe("timeout");
  });

  it("blames the deadline when the backend rejects from its own abort listener", async () => {
    const judge: Judge = {
      label: "test/abort-rejects",
      judge: (_request, options) =>
        new Promise((_settle, fail) => {
          options?.signal?.addEventListener("abort", () => fail(new Error("AbortError: request aborted")), {
            once: true,
          });
        }),
    };
    const lane = new FabricJudgmentLane(config({ timeoutMs: 20 }), async () => judge);

    const outcome = await lane.ask("state", { a: { type: "noul", instructions: "yes?" } });

    expect(outcome).toEqual({ ok: false, reason: "timeout", detail: "no answer within 20ms" });
    expect(lane.stats().timeouts).toBe(1);
    expect(lane.stats().failures).toBe(0);
  });

  it("leaves no abort listener behind on a settled ask", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config(), async () => judge);
    const controller = new AbortController();

    for (let index = 0; index < 5; index++) {
      await lane.ask(`state-${index}`, { a: { type: "noul", instructions: "a?" } }, {
        signal: controller.signal,
      });
    }

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("refuses a single call that exceeds the question cap", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config({ maxQuestionsPerRequest: 1 }), async () => judge);

    const outcome = await lane.ask("state", {
      a: { type: "noul", instructions: "a?" },
      b: { type: "noul", instructions: "b?" },
    });

    expect(outcome.ok === false && outcome.reason).toBe("refused");
    expect(judge.requests).toHaveLength(0);
  });

  it("reports a deadline distinctly from a backend failure", async () => {
    const judge = recordingJudge({ hang: true });
    const lane = new FabricJudgmentLane(config({ timeoutMs: 20 }), async () => judge);

    const outcome = await lane.ask("state", { a: { type: "noul", instructions: "yes?" } });

    expect(outcome.ok === false && outcome.reason).toBe("timeout");
    expect(outcome.ok === false && outcome.detail).toBe("no answer within 20ms");
    expect(lane.stats().timeouts).toBe(1);
    expect(lane.stats().failures).toBe(0);
  });

  it("abandons a caller whose signal aborts", async () => {
    const judge = recordingJudge({ hang: true });
    const lane = new FabricJudgmentLane(config({ timeoutMs: 5_000 }), async () => judge);
    const controller = new AbortController();

    const pending = lane.ask("state", { a: { type: "noul", instructions: "yes?" } }, {
      signal: controller.signal,
    });
    controller.abort();

    expect(await pending).toEqual({ ok: false, reason: "aborted" });
  });

  it("treats a missing answer as a failed judgment", async () => {
    const judge = recordingJudge({ omit: "_b" });
    const lane = new FabricJudgmentLane(config(), async () => judge);

    const outcome = await lane.ask("state", {
      a: { type: "noul", instructions: "a?" },
      b: { type: "noul", instructions: "b?" },
    });

    expect(outcome.ok === false && outcome.reason).toBe("failed");
    expect(outcome.ok === false && outcome.detail).toContain('"b"');
  });

  it("stays inert when disabled", async () => {
    const judge = recordingJudge();
    const lane = new FabricJudgmentLane(config({ enabled: false }), async () => judge);

    expect(await lane.ask("state", { a: { type: "noul", instructions: "yes?" } })).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(judge.requests).toHaveLength(0);
  });
});
