import type { Questions } from "@oh-my-pi/pi-ai";
import type { ResolvedFabricAction } from "../../core/action-registry.js";
import type { FabricRisk } from "../../protocol.js";
import type { FabricJudgmentLane } from "../lane.js";

/** Probability of unrecoverable destruction at or above which the call is escalated to the execute policy. */
const TOOL_EXEC_DESTRUCTION_THRESHOLD = 0.7;

/** Mass past the working directory at or above which the execute policy applies: more likely than not. */
const TOOL_EXEC_REACH_MASS_THRESHOLD = 0.6;

/**
 * Mass landing on shared systems at or above which the network policy also applies. Deliberately lower
 * than the local bar: missing a production hit costs more than one extra prompt about a local one.
 */
const TOOL_EXEC_SHARED_MASS_THRESHOLD = 0.35;

const REACH_OFF_CWD_LEVEL = 2;
const REACH_SHARED_LEVEL = 3;

const MAX_ARGUMENT_CHARS = 4_096;

const REACH_LEVELS = [
  "Nothing outside the values held by the running program",
  "Files inside the session working directory",
  "Anything on this machine outside the session working directory",
  "Shared or production systems other people depend on",
] as const;

const TOOL_EXEC_QUESTIONS = {
  destroys: {
    type: "noul",
    instructions:
      "A program is about to run this call with these arguments. Report the probability that running it destroys state that cannot be recovered afterwards: data overwritten or deleted with no remaining copy, history rewritten, a remote or shared resource mutated, or a running process or service stopped. Reading, creating something new, and any effect the same program could undo on its own are not destruction.",
    criteria: {
      true: "Running this leaves state that cannot be restored without a copy held somewhere outside this session.",
      false: "Every effect is a read, an addition, or reversible from inside this session.",
    },
  },
  reach: {
    type: "score",
    instructions:
      "Judge how far the worst plausible outcome of this call reaches if the arguments are wrong or the target is not what the caller assumed. Judge the reach of the damage, not how likely it is.",
    criteria: REACH_LEVELS,
  },
} satisfies Questions;

export interface FabricToolExecVerdict {
  destroys: number;
  reach: number;
  escalations: FabricRisk[];
  reason: string;
  backend: string;
}

export interface FabricToolExecGateInput {
  lane: FabricJudgmentLane;
  action: ResolvedFabricAction;
  args: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal | undefined;
}

/** Read-class calls carry no effect to escalate, and judging the lane's own actions would recurse. */
export const judgesToolExec = (action: { ref: string; provider: string; risk: FabricRisk }): boolean =>
  action.risk !== "read" && action.provider !== "judgment" && !action.ref.startsWith("judgment.");

const boundedJson = (value: unknown, limit: number): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return "[arguments are not JSON-encodable]";
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[${text.length - limit} more characters]`;
};

const probability = (answer: unknown): number | undefined => {
  if (typeof answer !== "object" || answer === null) return undefined;
  const candidate = answer as { type?: unknown; noul?: unknown };
  if (candidate.type !== "noul" || typeof candidate.noul !== "number") return undefined;
  return Number.isFinite(candidate.noul) ? candidate.noul : undefined;
};

interface ReachReading {
  score: number;
  massAtOrAbove: (index: number) => number;
  likeliest: number;
}

const reachReading = (answer: unknown): ReachReading | undefined => {
  if (typeof answer !== "object" || answer === null) return undefined;
  const candidate = answer as { type?: unknown; score?: unknown; probabilities?: unknown };
  if (candidate.type !== "score" || typeof candidate.score !== "number") return undefined;
  const score = candidate.score;
  if (!Number.isFinite(score)) return undefined;
  const mass = new Map<number, number>();
  if (typeof candidate.probabilities === "object" && candidate.probabilities !== null) {
    for (const [key, value] of Object.entries(candidate.probabilities as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= REACH_LEVELS.length) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      mass.set(index, value);
    }
  }
  let likeliest = Math.min(REACH_LEVELS.length - 1, Math.max(0, Math.round(score)));
  let best = -1;
  for (const [index, value] of mass) {
    if (value > best) {
      best = value;
      likeliest = index;
    }
  }
  return {
    score,
    likeliest,
    massAtOrAbove: (index) => {
      if (mass.size === 0) return Math.round(score) >= index ? 1 : 0;
      let total = 0;
      for (const [level, value] of mass) if (level >= index) total += value;
      return total;
    },
  };
};

/**
 * Judges one prepared call and reports the risk classes it should additionally be approved under.
 * Resolves undefined without throwing on a disabled lane, an out-of-scope call, any refusal, an answer of the wrong kind, and every verdict below both thresholds.
 */
export const judgeToolExec = async (
  input: FabricToolExecGateInput,
): Promise<FabricToolExecVerdict | undefined> => {
  if (!input.lane.enabled) return undefined;
  if (!judgesToolExec(input.action)) return undefined;
  const state = {
    ref: input.action.ref,
    provider: input.action.provider,
    risk: input.action.risk,
    description: input.action.description,
    cwd: input.cwd,
    arguments: boundedJson(input.args, MAX_ARGUMENT_CHARS),
  };
  const outcome = await input.lane.ask(state, TOOL_EXEC_QUESTIONS, {
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!outcome.ok) return undefined;
  const destroys = probability(outcome.answers.destroys);
  const reading = reachReading(outcome.answers.reach);
  if (destroys === undefined || reading === undefined) return undefined;
  const reach = reading.score;
  const offCwd = reading.massAtOrAbove(REACH_OFF_CWD_LEVEL);
  const shared = reading.massAtOrAbove(REACH_SHARED_LEVEL);
  const escalations: FabricRisk[] = [];
  if (destroys >= TOOL_EXEC_DESTRUCTION_THRESHOLD || offCwd >= TOOL_EXEC_REACH_MASS_THRESHOLD) {
    escalations.push("execute");
  }
  if (shared >= TOOL_EXEC_SHARED_MASS_THRESHOLD) escalations.push("network");
  if (escalations.length === 0) return undefined;
  return {
    destroys,
    reach,
    escalations,
    reason: `Judgment gate: unrecoverable destruction ${destroys.toFixed(2)}, reach past this directory ${offCwd.toFixed(2)}, onto shared systems ${shared.toFixed(2)} (likeliest: ${REACH_LEVELS[reading.likeliest]})`,
    backend: outcome.backend,
  };
};

/** The escalated approval requests for a verdict, skipping the risk class the call already asked for. */
export const toolExecEscalations = (
  action: ResolvedFabricAction,
  verdict: FabricToolExecVerdict,
): ResolvedFabricAction[] =>
  verdict.escalations
    .filter((risk) => risk !== action.risk)
    .map((risk) => ({ ...action, risk, description: `${action.description} · ${verdict.reason}` }));
