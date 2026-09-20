import type { FabricAgentRunner } from "../../config.js";
import { THINKING_LEVELS, type FabricThinking } from "../../thinking.js";
import type { FabricJudgmentLane } from "../lane.js";

export interface DelegationGateCandidate {
  kind: FabricAgentRunner;
  tools: string[];
}

export interface DelegationGateInput {
  task: string;
  cwd: string;
  candidates: readonly DelegationGateCandidate[];
  needRunner: boolean;
  needThinking: boolean;
}

export interface DelegationGateDecision {
  runner?: FabricAgentRunner;
  thinking?: FabricThinking;
}

/** Minimum answer confidence before the gate replaces a configured default. */
export const DELEGATION_GATE_MIN_CONFIDENCE = 0.6;

const DELEGATION_RUNNER_CRITERIA: Record<FabricAgentRunner, string> = {
  omp: "The full Fabric runner: the whole listed tool surface, recursive delegation, and programmatic execution. Pick it for multi-step work, code edits, investigation, or anything that needs tools.",
  claude: "The Claude Code CLI: its own coding tool surface, one session, no recursion and no Fabric. Pick it for self-contained coding work that fits a single CLI session.",
  veda: "One headless persona prompt: no tools, no recursion, no follow-up. Pick it only for one-shot writing or judgement that needs nothing from the filesystem.",
};

const EFFORT_CRITERIA: Record<FabricThinking, string> = {
  off: "off. Mechanical: a lookup, a rename, or one unambiguous edit with no decision to make.",
  minimal: "minimal. Nearly mechanical: one small decision over a shape that is already known.",
  low: "low. Routine: a short, well-specified change in familiar code.",
  medium: "medium. Ordinary engineering: several steps, some exploration, one real design decision.",
  high: "high. Hard: unfamiliar code, several interacting constraints, or a cause that is not visible from the symptom.",
  xhigh: "xhigh. Very hard: open-ended design, or a defect whose root cause has to be derived before anything can be written.",
  max: "max. Extreme: research-grade work where a wrong early decision wastes the entire run.",
};

const DELEGATION_AGENT_KIND_INSTRUCTIONS =
  "Pick the agent kind that should execute this delegated run. Judge it from the task text, the working directory, and the tools each kind would give the child: choose the kind whose capabilities the task actually needs, and the cheapest one when several would do.";

const DELEGATION_EFFORT_INSTRUCTIONS =
  "Rate how much reasoning effort this delegated task warrants. Judge the difficulty of the work itself, not its importance, its urgency, or the length of the prompt.";

const EFFORT_LEVELS = THINKING_LEVELS.map(
  (level) => EFFORT_CRITERIA[level],
) as unknown as readonly [string, string, ...string[]];

/** Agent kinds whose shape rules this request satisfies, before tool and model compatibility. */
export const eligibleRunners = (request: {
  persona?: string;
  recursive?: boolean;
  sessionSeed?: unknown;
}): FabricAgentRunner[] => {
  const persona = Boolean(request.persona);
  const ompOnly = request.recursive === true || request.sessionSeed !== undefined;
  const runners: FabricAgentRunner[] = [];
  if (!persona) runners.push("omp");
  if (!persona && !ompOnly) runners.push("claude");
  if (!ompOnly) runners.push("veda");
  return runners;
};

/** Highest-mass level the judge actually put mass on; ties resolve to the lower effort. */
export const thinkingFromProbabilities = (probabilities: unknown): FabricThinking | undefined => {
  if (!probabilities || typeof probabilities !== "object") return undefined;
  let bestIndex = -1;
  let bestMass = 0;
  for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= THINKING_LEVELS.length) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= bestMass) continue;
    bestIndex = index;
    bestMass = value;
  }
  return bestIndex < 0 ? undefined : THINKING_LEVELS[bestIndex];
};

/** Ask the lane for the agent kind and effort of a run the caller did not specify; never throws. */
export const judgeDelegation = async (
  lane: FabricJudgmentLane,
  input: DelegationGateInput,
  signal?: AbortSignal,
): Promise<DelegationGateDecision | undefined> => {
  const askKind = input.needRunner && input.candidates.length >= 2;
  if (!askKind && !input.needThinking) return undefined;
  const criteria: Record<string, string | null> = {};
  for (const candidate of input.candidates) {
    criteria[candidate.kind] = DELEGATION_RUNNER_CRITERIA[candidate.kind];
  }
  const questions: Record<string, unknown> = {};
  if (askKind) {
    questions.agentKind = {
      type: "choice",
      instructions: DELEGATION_AGENT_KIND_INSTRUCTIONS,
      criteria,
    };
  }
  if (input.needThinking) {
    questions.effort = {
      type: "score",
      instructions: DELEGATION_EFFORT_INSTRUCTIONS,
      criteria: EFFORT_LEVELS,
    };
  }
  const outcome = await lane.ask(
    {
      task: input.task,
      cwd: input.cwd,
      agentKinds: input.candidates.map((candidate) => ({
        kind: candidate.kind,
        tools: [...candidate.tools],
      })),
    },
    questions as Parameters<FabricJudgmentLane["ask"]>[1],
    signal ? { signal } : undefined,
  );
  if (!outcome.ok) return undefined;
  const answers = outcome.answers as Record<string, unknown>;
  const decision: DelegationGateDecision = {};
  const kind = answers.agentKind as { choice?: unknown; confidence?: unknown } | undefined;
  if (
    askKind &&
    kind &&
    typeof kind.choice === "string" &&
    input.candidates.some((candidate) => candidate.kind === kind.choice) &&
    typeof kind.confidence === "number" &&
    kind.confidence >= DELEGATION_GATE_MIN_CONFIDENCE
  ) {
    decision.runner = kind.choice as FabricAgentRunner;
  }
  const effort = answers.effort as
    | { probabilities?: unknown; confidence?: unknown }
    | undefined;
  if (
    input.needThinking &&
    effort &&
    typeof effort.confidence === "number" &&
    effort.confidence >= DELEGATION_GATE_MIN_CONFIDENCE
  ) {
    const level = thinkingFromProbabilities(effort.probabilities);
    if (level) decision.thinking = level;
  }
  return decision.runner === undefined && decision.thinking === undefined ? undefined : decision;
};
