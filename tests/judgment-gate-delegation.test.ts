import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Answer, Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { AgentManager } from "../src/agents/manager.js";
import { clearOwnedBudgetEnv } from "../src/agents/budget-ledger.js";
import { FabricJudgmentLane } from "../src/judgment/lane.js";
import {
  DELEGATION_GATE_MIN_CONFIDENCE,
  eligibleRunners,
  thinkingFromProbabilities,
} from "../src/judgment/gates/delegation.js";

const managers: AgentManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  clearOwnedBudgetEnv();
});

interface StubAnswers {
  choice?: string;
  choiceConfidence?: number;
  effort?: Record<string, number>;
  effortConfidence?: number;
}

const stubLane = (answers: StubAnswers, seen: JudgmentRequest[] = []): FabricJudgmentLane => {
  const judge: Judge = {
    label: "test/delegation",
    async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
      seen.push(request);
      const out: Record<string, Answer> = {};
      for (const id in request.questions) {
        const question = request.questions[id]!;
        if (question.type === "choice") {
          const labels = Object.keys(question.criteria);
          const choice = answers.choice ?? labels[0]!;
          const probabilities: Record<string, number> = {};
          for (const label of labels) probabilities[label] = label === choice ? 1 : 0;
          out[id] = {
            type: "choice",
            choice,
            probabilities,
            confidence: answers.choiceConfidence ?? 0.95,
          };
        } else if (question.type === "score") {
          const probabilities = answers.effort ?? { "4": 0.8, "3": 0.2 };
          let score = 0;
          for (const [level, mass] of Object.entries(probabilities)) score += Number(level) * mass;
          out[id] = {
            type: "score",
            score,
            probabilities,
            confidence: answers.effortConfidence ?? 0.95,
          };
        } else {
          out[id] = { type: "noul", noul: 0.5 };
        }
      }
      return {
        api: "test",
        provider: "test",
        model: "delegation-stub",
        answers: out as JudgmentResult<Q>["answers"],
        usage: tokenUsage(4, 2),
      };
    },
  };
  return new FabricJudgmentLane(
    { ...DEFAULT_FABRIC_CONFIG.judgment, coalesceMs: 1, timeoutMs: 2_000 },
    async () => judge,
  );
};

interface ExplodingLane {
  lane: FabricJudgmentLane;
  touches: () => number;
}

const explodingLane = (): ExplodingLane => {
  let touches = 0;
  return {
    touches: () => touches,
    lane: {
      enabled: true,
      ask: () => {
        touches++;
        throw new Error("delegation gate touched the lane");
      },
    } as unknown as FabricJudgmentLane,
  };
};

const gates = (delegation: boolean) => () => ({
  ...DEFAULT_FABRIC_CONFIG.judgment.gates,
  delegation,
});

const manager = (options: {
  judgment?: FabricJudgmentLane;
  judgmentGates?: () => typeof DEFAULT_FABRIC_CONFIG.judgment.gates;
  budgetUsd?: number;
}): AgentManager => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-delegation-"));
  roots.push(root);
  const { budgetUsd, ...rest } = options;
  const created = new AgentManager(
    process.cwd(),
    { ...DEFAULT_FABRIC_CONFIG.agents, ...(budgetUsd === undefined ? {} : { budgetUsd }) },
    {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      ...rest,
    },
  );
  managers.push(created);
  return created;
};

const offeredKinds = (request: JudgmentRequest): string[] =>
  ((request.state as { agentKinds: Array<{ kind: string }> }).agentKinds ?? []).map(
    (entry) => entry.kind,
  );

const offeredTools = (request: JudgmentRequest, kind: string): string[] =>
  ((request.state as { agentKinds: Array<{ kind: string; tools: string[] }> }).agentKinds ?? [])
    .find((entry) => entry.kind === kind)?.tools ?? [];

const askedIds = (request: JudgmentRequest): string[] => Object.keys(request.questions);

const exhaustBudget = (): void => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-delegation-budget-"));
  roots.push(directory);
  const file = path.join(directory, "cost.jsonl");
  fs.writeFileSync(file, JSON.stringify({ cost: 5, tokens: 100 }) + "\n");
  process.env.OMP_FABRIC_BUDGET = "1";
  process.env.OMP_FABRIC_BUDGET_FILE = file;
  process.env.OMP_FABRIC_BUDGET_ID = "delegation-test";
};

describe("eligibleRunners", async () => {
  it("offers every kind for a plain request", async () => {
    expect(eligibleRunners({})).toEqual(["omp", "claude", "veda"]);
  });

  it("drops the kinds a recursive or seeded request cannot legally use", async () => {
    expect(eligibleRunners({ recursive: true })).toEqual(["omp"]);
    expect(eligibleRunners({ sessionSeed: {} })).toEqual(["omp"]);
  });

  it("offers only the persona-capable kind when a persona is requested", async () => {
    expect(eligibleRunners({ persona: "navigator-chat" })).toEqual(["veda"]);
  });
});

describe("thinkingFromProbabilities", async () => {
  it("returns the level carrying the most mass", async () => {
    expect(thinkingFromProbabilities({ "2": 0.1, "5": 0.9 })).toBe("xhigh");
  });

  it("resolves a tie to the lower effort and never invents a level between them", async () => {
    expect(thinkingFromProbabilities({ "0": 0.5, "6": 0.5 })).toBe("off");
  });

  it("refuses a distribution it cannot read", async () => {
    expect(thinkingFromProbabilities(undefined)).toBeUndefined();
    expect(thinkingFromProbabilities({})).toBeUndefined();
    expect(thinkingFromProbabilities({ "9": 1 })).toBeUndefined();
    expect(thinkingFromProbabilities({ high: 1 })).toBeUndefined();
  });
});

describe("delegation gate", async () => {
  it("never reaches the lane while the gate is off", async () => {
    const inert = explodingLane();
    const agents = manager({ judgment: inert.lane, judgmentGates: gates(false) });
    const handle = await agents.spawn({ task: "Off by default", transport: "process" });
    expect(inert.touches()).toBe(0);
    expect(handle.runner).toBe(DEFAULT_FABRIC_CONFIG.agents.runner);
    expect(handle.thinking).toBe(DEFAULT_FABRIC_CONFIG.agents.thinking);
  });

  it("never reaches the lane when the caller set both fields", async () => {
    const inert = explodingLane();
    const agents = manager({ judgment: inert.lane, judgmentGates: gates(true) });
    const handle = await agents.spawn({
      task: "Fully specified",
      transport: "process",
      runner: "omp",
      thinking: "low",
    });
    expect(inert.touches()).toBe(0);
    expect(handle.runner).toBe("omp");
    expect(handle.thinking).toBe("low");
  });

  it("fills the agent kind and the effort the caller left unset", async () => {
    const seen: JudgmentRequest[] = [];
    const agents = manager({
      judgment: stubLane({ choice: "claude", effort: { "4": 0.8, "3": 0.2 } }, seen),
      judgmentGates: gates(true),
    });
    const handle = await agents.spawn({ task: "Unspecified delegation", transport: "process" });
    expect(handle.runner).toBe("claude");
    expect(handle.thinking).toBe("high");
    expect(seen).toHaveLength(1);
    const state = seen[0]!.state as Record<string, unknown>;
    expect(state.task).toBe("Unspecified delegation");
    expect(state.cwd).toBe(process.cwd());
    expect(offeredKinds(seen[0]!)).toEqual(["omp", "claude", "veda"]);
    expect(askedIds(seen[0]!).some((id) => id.endsWith("_agentKind"))).toBe(true);
    expect(askedIds(seen[0]!).some((id) => id.endsWith("_effort"))).toBe(true);
  });

  it("leaves a caller-named agent kind and effort untouched", async () => {
    const seen: JudgmentRequest[] = [];
    const agents = manager({
      judgment: stubLane({ choice: "claude", effort: { "4": 1 } }, seen),
      judgmentGates: gates(true),
    });
    const kept = await agents.spawn({
      task: "Caller named the runner",
      transport: "process",
      runner: "omp",
    });
    expect(kept.runner).toBe("omp");
    expect(kept.thinking).toBe("high");

    const effort = await agents.spawn({
      task: "Caller named the effort",
      transport: "process",
      thinking: "minimal",
    });
    expect(effort.runner).toBe("claude");
    expect(effort.thinking).toBe("minimal");
  });

  it("leaves the defaults alone when the judge is not confident", async () => {
    const agents = manager({
      judgment: stubLane({
        choice: "claude",
        choiceConfidence: 0.2,
        effort: { "4": 1 },
        effortConfidence: 0.2,
      }),
      judgmentGates: gates(true),
    });
    expect(DELEGATION_GATE_MIN_CONFIDENCE).toBeGreaterThan(0.2);
    const handle = await agents.spawn({ task: "Coin flip", transport: "process" });
    expect(handle.runner).toBe(DEFAULT_FABRIC_CONFIG.agents.runner);
    expect(handle.thinking).toBe(DEFAULT_FABRIC_CONFIG.agents.thinking);
  });

  it("configures an effort the judge put mass on, never the midpoint of a split", async () => {
    const agents = manager({
      judgment: stubLane({ choice: "omp", effort: { "0": 0.5, "6": 0.5 } }),
      judgmentGates: gates(true),
    });
    const handle = await agents.spawn({ task: "Split distribution", transport: "process" });
    expect(handle.thinking).not.toBe("medium");
    expect(handle.thinking).toBe("off");
  });

  it("keeps the run alive when the lane refuses", async () => {
    const refusing = new FabricJudgmentLane(
      { ...DEFAULT_FABRIC_CONFIG.judgment, enabled: false },
      async () => undefined,
    );
    const agents = manager({ judgment: refusing, judgmentGates: gates(true) });
    const handle = await agents.spawn({ task: "Refused judgment", transport: "process" });
    expect(handle.runner).toBe(DEFAULT_FABRIC_CONFIG.agents.runner);
    expect(handle.thinking).toBe(DEFAULT_FABRIC_CONFIG.agents.thinking);
  });

  it("never offers an agent kind the request could not legally use", async () => {
    const seen: JudgmentRequest[] = [];
    const agents = manager({
      judgment: stubLane({ choice: "claude", effort: { "4": 1 } }, seen),
      judgmentGates: gates(true),
    });
    const handle = await agents.spawn({
      task: "Recursive delegation",
      transport: "process",
      recursive: true,
    });
    expect(handle.runner).toBe("omp");
    expect(seen).toHaveLength(1);
    expect(offeredKinds(seen[0]!)).toEqual(["omp"]);
    expect(askedIds(seen[0]!).some((id) => id.endsWith("_agentKind"))).toBe(false);
    expect(askedIds(seen[0]!).some((id) => id.endsWith("_effort"))).toBe(true);
  });

  it("never offers a kind whose tool mapper rejects the requested tools", async () => {
    const seen: JudgmentRequest[] = [];
    const agents = manager({
      judgment: stubLane({ choice: "claude", effort: { "4": 1 } }, seen),
      judgmentGates: gates(true),
    });
    const handle = await agents.spawn({
      task: "Needs a tool only OMP has",
      transport: "process",
      tools: ["read", "web_search"],
    });
    expect(handle.runner).toBe("omp");
    expect(seen).toHaveLength(1);
    expect(offeredKinds(seen[0]!)).toEqual(["omp"]);
    expect(askedIds(seen[0]!).some((id) => id.endsWith("_agentKind"))).toBe(false);
  });

  it("shows each offered kind the tools that kind would actually get", async () => {
    const seen: JudgmentRequest[] = [];
    const agents = manager({
      judgment: stubLane({ choice: "claude", effort: { "4": 1 } }, seen),
      judgmentGates: gates(true),
    });
    await agents.spawn({ task: "Per-kind tool surface", transport: "process" });
    expect(seen).toHaveLength(1);
    expect(offeredKinds(seen[0]!)).toEqual(["omp", "claude", "veda"]);
    expect(offeredTools(seen[0]!, "omp")).toContain("fabric_exec");
    expect(offeredTools(seen[0]!, "claude")).not.toContain("fabric_exec");
    expect(offeredTools(seen[0]!, "claude")).toContain("read");
    expect(offeredTools(seen[0]!, "veda")).not.toContain("fabric_exec");
    expect(offeredTools(seen[0]!, "veda")).toContain("read");
  });

  it("does not reroute a run whose model the caller pinned", async () => {
    const seen: JudgmentRequest[] = [];
    const agents = manager({
      judgment: stubLane({ choice: "claude", effort: { "4": 1 } }, seen),
      judgmentGates: gates(true),
    });
    const handle = await agents.spawn({
      task: "Pinned model",
      transport: "process",
      model: "openai/gpt-5",
    });
    expect(handle.runner).toBe("omp");
    expect(handle.model).toBe("openai/gpt-5");
    expect(handle.thinking).toBe("high");
    expect(seen).toHaveLength(1);
    expect(offeredKinds(seen[0]!)).toEqual(["omp"]);
    expect(askedIds(seen[0]!).some((id) => id.endsWith("_agentKind"))).toBe(false);
  });

  it("does not spend a judgment on a run the budget already rejects", async () => {
    exhaustBudget();
    const inert = explodingLane();
    const agents = manager({
      judgment: inert.lane,
      judgmentGates: gates(true),
      budgetUsd: 1,
    });
    await expect(
      agents.spawn({ task: "Over budget", transport: "process" }),
    ).rejects.toThrow(/budget exceeded/i);
    expect(inert.touches()).toBe(0);
  });
});
