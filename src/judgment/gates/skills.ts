import { readFileSync } from "node:fs";
import type { FabricJudgmentLane } from "../lane.js";

export interface SkillCandidate {
  name: string;
  description: string;
  filePath?: string;
}

export interface SkillSuggestion {
  name: string;
  probability: number;
  confidence: number;
}

const NONE = "__none__";
const SHORTLIST = 3;
/** TypeSafe rejects a Choice carrying more than 255 options, and the none label takes one. */
const MAX_CHOICE_OPTIONS = 254;
const ROSTER_DESCRIPTION_CHARS = 200;
const ROSTER_NARROW_CHARS = 96;
const ROSTER_BYTE_BUDGET = 48 * 1024;
const DETAIL_CHARS = 700;
const ACTS_THRESHOLD = 0.5;
const PROCEDURE_THRESHOLD = 0.5;
const CONVERSATION_CEILING = 0.5;
const FITS_THRESHOLD = 0.6;
/** Both passes together, so a stalled backend cannot hold the turn for two full lane deadlines. */
export const SKILL_GATE_BUDGET_MS = 6_000;

const clip = (value: string, chars: number): string =>
  value.length <= chars ? value : `${value.slice(0, chars - 1)}…`;

const rosterCriteria = (
  skills: readonly SkillCandidate[],
  chars: number,
): Record<string, string | null> => {
  const criteria: Record<string, string | null> = {};
  for (const skill of skills) criteria[skill.name] = clip(skill.description, chars);
  criteria[NONE] = "No skill in this roster fits the request.";
  return criteria;
};

const budgetedRoster = (skills: readonly SkillCandidate[]): Record<string, string | null> => {
  const wide = rosterCriteria(skills, ROSTER_DESCRIPTION_CHARS);
  const bytes = Buffer.byteLength(JSON.stringify(wide), "utf-8");
  return bytes <= ROSTER_BYTE_BUDGET ? wide : rosterCriteria(skills, ROSTER_NARROW_CHARS);
};

const shards = (skills: readonly SkillCandidate[]): SkillCandidate[][] => {
  const count = Math.ceil(skills.length / MAX_CHOICE_OPTIONS);
  const size = Math.ceil(skills.length / count);
  const groups: SkillCandidate[][] = [];
  for (let index = 0; index < skills.length; index += size) {
    groups.push(skills.slice(index, index + size));
  }
  return groups;
};

const body = (source: string): string => {
  if (!source.startsWith("---")) return source;
  const end = source.indexOf("\n---", 3);
  return end < 0 ? source : source.slice(end + 4).trimStart();
};

const opening = (skill: SkillCandidate): string => {
  if (!skill.filePath) return skill.description;
  try {
    const text = body(readFileSync(skill.filePath, "utf-8")).trim();
    return text.length === 0 ? skill.description : clip(text, DETAIL_CHARS);
  } catch {
    return skill.description;
  }
};

/** At most one skill name for this turn, or `undefined` when the roster offers nothing that fits. */
export const suggestSkill = async (
  lane: FabricJudgmentLane,
  prompt: string,
  skills: readonly SkillCandidate[],
  options?: { signal?: AbortSignal },
): Promise<SkillSuggestion | undefined> => {
  if (skills.length < 2) return undefined;
  const ask = options?.signal !== undefined ? { signal: options.signal } : undefined;

  const groups = shards(skills);
  const picks: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string | null> }> = {};
  groups.forEach((group, index) => {
    picks[`pick_${index}`] = {
      type: "choice",
      instructions:
        "Which of these skills covers what this request asks for? Each option is a skill name and the situation it is written for.",
      criteria: budgetedRoster(group),
    };
  });

  const ranked = await lane.ask(
    prompt,
    {
      ...picks,
      acts_on_their_work: {
        type: "noul",
        instructions:
          "Does answering this request mean acting on the user's own files, systems, or data?",
      },
      follows_a_procedure: {
        type: "noul",
        instructions:
          "Does this request call for an established procedure with steps, gates, or known pitfalls?",
      },
      conversation_only: {
        type: "noul",
        instructions: "Is the user only asking something answerable from general knowledge?",
      },
    },
    ask,
  );
  if (!ranked.ok) return undefined;

  const acts = ranked.answers.acts_on_their_work.noul;
  const procedure = ranked.answers.follows_a_procedure.noul;
  const conversation = ranked.answers.conversation_only.noul;
  if (conversation > CONVERSATION_CEILING) return undefined;
  if (acts < ACTS_THRESHOLD && procedure < PROCEDURE_THRESHOLD) return undefined;

  const scored = ranked.answers as Record<string, { probabilities?: Record<string, number> }>;
  const best = new Map<string, number>();
  for (const key of Object.keys(picks)) {
    const probabilities = scored[key]?.probabilities ?? {};
    for (const [name, probability] of Object.entries(probabilities)) {
      if (name === NONE) continue;
      const seen = best.get(name) ?? 0;
      if (probability > seen) best.set(name, probability);
    }
  }
  const shortlist = [...best.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, SHORTLIST)
    .map(([name]) => skills.find((skill) => skill.name === name))
    .filter((skill): skill is SkillCandidate => skill !== undefined);
  if (shortlist.length === 0) return undefined;

  const detail: Record<string, string | null> = {};
  for (const skill of shortlist) detail[skill.name] = opening(skill);
  detail[NONE] = "None of these three fits the request.";

  const fits: Record<string, { type: "noul"; instructions: string }> = {};
  for (const skill of shortlist) {
    fits[`fits_${skill.name.replaceAll(/[^A-Za-z0-9]/gu, "_")}`] = {
      type: "noul",
      instructions: `Does the skill "${skill.name}" do what this request asks for?`,
    };
  }

  const verified = await lane.ask(
    { request: prompt, candidates: detail },
    {
      pick: {
        type: "choice",
        instructions:
          "Read these three skills properly and pick the one this request needs, or reject all three.",
        criteria: detail,
      },
      ...fits,
    },
    ask,
  );
  if (!verified.ok) return undefined;

  const winner = verified.answers.pick.choice;
  if (winner === NONE) return undefined;
  const key = `fits_${winner.replaceAll(/[^A-Za-z0-9]/gu, "_")}`;
  const answered = verified.answers as Record<string, { type: string; noul?: number }>;
  const fit = answered[key];
  if (!fit || fit.type !== "noul" || (fit.noul ?? 0) < FITS_THRESHOLD) return undefined;

  return {
    name: winner,
    probability: fit.noul ?? 0,
    confidence: verified.answers.pick.confidence,
  };
};

/** One line for the turn's message channel; the roster and the model's own judgment stay untouched. */
export const skillSuggestionBlock = (suggestion: SkillSuggestion): string =>
  `<skill_relevance>\nRelevant to the current request: ${suggestion.name}. Ignore this if it does not fit what the user asked for.\n</skill_relevance>`;
