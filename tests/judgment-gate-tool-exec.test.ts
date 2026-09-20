import type { Answer, Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { judgesToolExec } from "../src/judgment/gates/tool-exec.js";
import { FabricJudgmentLane } from "../src/judgment/lane.js";

const removeDescriptor = {
  name: "remove",
  description: "delete a path",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    additionalProperties: false,
  },
  risk: "write" as const,
};

const listDescriptor = {
  name: "list",
  description: "list a path",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    additionalProperties: false,
  },
  risk: "read" as const,
};

const registryWithFiles = (): ActionRegistry => {
  const registry = new ActionRegistry();
  registry.register({
    name: "files",
    description: "files",
    async list() {
      return [removeDescriptor, listDescriptor];
    },
    async describe(name) {
      if (name === "remove") return removeDescriptor;
      return name === "list" ? listDescriptor : undefined;
    },
    async invoke(name, args) {
      return { action: name, path: args.path };
    },
  });
  return registry;
};

type GateAnswers = { destroys: number; reach: number; reachMass?: Record<string, number> };

const spread = (score: number): Record<string, number> => {
  const low = Math.max(0, Math.min(3, Math.floor(score)));
  const high = Math.min(3, low + 1);
  const upper = score - low;
  return low === high ? { [String(low)]: 1 } : { [String(low)]: 1 - upper, [String(high)]: upper };
};

const answeringJudge = (answers: GateAnswers, swap = false): Judge => ({
  label: "test/gate",
  async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
    const answered: Record<string, Answer> = {};
    for (const id in request.questions) {
      const question = request.questions[id]!;
      const wantsNoul = swap ? false : question.type === "noul";
      answered[id] = wantsNoul
        ? { type: "noul", noul: answers.destroys }
        : {
          type: "score",
          score: answers.reach,
          probabilities: answers.reachMass ?? spread(answers.reach),
          confidence: 0.9,
        };
    }
    return {
      api: "test",
      provider: "test",
      model: "gate-1",
      answers: answered as JudgmentResult<Q>["answers"],
      usage: tokenUsage(4, 2),
    };
  },
});

const realLane = (judge: Judge | undefined): FabricJudgmentLane =>
  new FabricJudgmentLane(
    { ...DEFAULT_FABRIC_CONFIG.judgment, coalesceMs: 1, timeoutMs: 2_000 },
    async () => judge,
  );

/** Counts every contact with the lane so a deleted guard fails on the counter, not on a swallowed throw. */
const counted = (
  inner: FabricJudgmentLane | undefined,
  enabled = true,
): { lane: FabricJudgmentLane; contacts: { count: number } } => {
  const contacts = { count: 0 };
  const lane = {
    get enabled() {
      return enabled;
    },
    async ask(state: unknown, questions: unknown, options: unknown) {
      contacts.count++;
      if (!inner) throw new Error("the judgment lane must not be consulted");
      return (inner as unknown as { ask(a: unknown, b: unknown, c: unknown): Promise<unknown> }).ask(
        state,
        questions,
        options,
      );
    },
  } as unknown as FabricJudgmentLane;
  return { lane, contacts };
};

const uiContext = (
  select: (prompt: string, options: string[]) => Promise<string>,
  hasUI = true,
): ExtensionContext =>
  ({
    cwd: process.cwd(),
    hasUI,
    mode: "dialog",
    ui: { notify() {}, select },
  }) as unknown as ExtensionContext;

const configFor = (toolExec: boolean) => {
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.read = "allow";
  config.approvals.write = "allow";
  config.approvals.execute = "ask";
  config.approvals.network = "ask";
  config.judgment.gates.toolExec = toolExec;
  return config;
};

const removeProgram = `return await tools.call({ ref: "files.remove", args: { path: "/srv/shared/data" } });`;

const gateOps = (result: { trace: { operations: Array<{ ref: string; outcome: string }> } }) =>
  result.trace.operations.filter((operation) => operation.ref === "fabric.judgment.toolExec");

const run = async (options: {
  toolExec: boolean;
  lane: FabricJudgmentLane;
  id: string;
  select?: (prompt: string, options: string[]) => Promise<string>;
  hasUI?: boolean;
  code?: string;
}) => {
  const service = new FabricExecutionService(registryWithFiles(), configFor(options.toolExec));
  service.setJudgment(options.lane);
  return service.execute({
    code: options.code ?? removeProgram,
    signal: undefined,
    parentToolCallId: options.id,
    context: uiContext(options.select ?? (async () => "Allow once"), options.hasUI ?? true),
    onPartial() {},
  });
};

describe("tool exec judgment gate", () => {
  it("scopes itself away from read-class calls and from the lane's own actions", () => {
    expect(judgesToolExec({ ref: "files.remove", provider: "files", risk: "write" })).toBe(true);
    expect(judgesToolExec({ ref: "files.list", provider: "files", risk: "read" })).toBe(false);
    expect(judgesToolExec({ ref: "judgment.ask", provider: "judgment", risk: "network" })).toBe(false);
  });

  it("never contacts the lane while the gate is off", async () => {
    const { lane, contacts } = counted(undefined);
    const result = await run({ toolExec: false, lane, id: "tool-exec-gate-off" });

    expect(contacts.count).toBe(0);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ action: "remove", path: "/srv/shared/data" });
  });

  it("never contacts the lane for a read-class call while the gate is on", async () => {
    const { lane, contacts } = counted(undefined);
    const result = await run({
      toolExec: true,
      lane,
      id: "tool-exec-gate-read",
      code: `return await tools.call({ ref: "files.list", args: { path: "." } });`,
    });

    expect(contacts.count).toBe(0);
    expect(result.success).toBe(true);
    expect(gateOps(result)).toHaveLength(0);
  });

  it("never contacts a disabled lane while the gate is on", async () => {
    const { lane, contacts } = counted(undefined, false);
    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-disabled" });

    expect(contacts.count).toBe(0);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ action: "remove", path: "/srv/shared/data" });
  });

  it("records a verdict but never escalates when no interactive UI can receive it", async () => {
    const select = vi.fn(async () => "Allow once");
    const { lane, contacts } = counted(realLane(answeringJudge({ destroys: 0.92, reach: 2.8 })));
    const result = await run({
      toolExec: true,
      lane,
      id: "tool-exec-gate-headless",
      select,
      hasUI: false,
    });

    expect(contacts.count).toBe(1);
    expect(select).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ action: "remove", path: "/srv/shared/data" });
    expect(gateOps(result)).toHaveLength(1);
    expect(gateOps(result)[0]!.outcome).toBe("succeeded");
  });

  it("escalates a destructive call reaching shared systems to both execute and network", async () => {
    const prompts: string[] = [];
    const select = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return "Allow once";
    });
    const { lane, contacts } = counted(realLane(answeringJudge({ destroys: 0.92, reach: 2.8 })));
    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-hit", select });

    expect(result.success).toBe(true);
    expect(contacts.count).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("requests execute access");
    expect(prompts[1]).toContain("requests network access");
    for (const prompt of prompts) {
      expect(prompt).toContain("unrecoverable destruction 0.92");
      expect(prompt).toContain("onto shared systems 0.80");
    }
  });

  it("escalates a split verdict whose tail lands on shared systems", async () => {
    const prompts: string[] = [];
    const select = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return "Allow once";
    });
    const { lane } = counted(realLane(answeringJudge({
      destroys: 0.1,
      reach: 1.2,
      reachMass: { "0": 0.6, "3": 0.4 },
    })));

    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-tail", select });

    expect(result.success).toBe(true);
    expect(prompts.map((prompt) => prompt.includes("requests network access"))).toContain(true);
  });

  it("keeps a machine-local reach out of the network policy", async () => {
    const prompts: string[] = [];
    const select = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return "Allow once";
    });
    const { lane } = counted(realLane(answeringJudge({ destroys: 0.92, reach: 2.2 })));
    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-local-reach", select });

    expect(result.success).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("requests execute access");
    expect(prompts.join(" ")).not.toContain("network access");
  });

  it("denies the call when the operator refuses the escalated request", async () => {
    const { lane } = counted(realLane(answeringJudge({ destroys: 0.92, reach: 0.1 })));
    const result = await run({
      toolExec: true,
      lane,
      id: "tool-exec-gate-deny",
      select: async () => "Deny",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("denied execute access");
  });

  it("leaves a call below both thresholds on its own approval path", async () => {
    const select = vi.fn(async () => "Allow once");
    const { lane, contacts } = counted(realLane(answeringJudge({ destroys: 0.55, reach: 1.4 })));
    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-quiet", select });

    expect(result.success).toBe(true);
    expect(contacts.count).toBe(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("declines the verdict when the backend answers with the wrong question kinds", async () => {
    const select = vi.fn(async () => "Allow once");
    const { lane, contacts } = counted(realLane(answeringJudge({ destroys: 0.99, reach: 3 }, true)));
    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-wrong-kind", select });

    expect(result.success).toBe(true);
    expect(contacts.count).toBe(1);
    expect(select).not.toHaveBeenCalled();
    expect(result.value).toEqual({ action: "remove", path: "/srv/shared/data" });
    expect(gateOps(result)).toHaveLength(1);
    expect(gateOps(result)[0]!.outcome).toBe("succeeded");
  });

  it("runs the call unchanged when the lane has no backend", async () => {
    const select = vi.fn(async () => "Allow once");
    const { lane, contacts } = counted(realLane(undefined));
    const result = await run({ toolExec: true, lane, id: "tool-exec-gate-refused", select });

    expect(result.success).toBe(true);
    expect(contacts.count).toBe(1);
    expect(select).not.toHaveBeenCalled();
    expect(result.value).toEqual({ action: "remove", path: "/srv/shared/data" });
  });
});
