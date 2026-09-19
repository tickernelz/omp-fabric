import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type {
  ChoiceQuestion,
  JudgmentState,
  NoulQuestion,
  Question,
  Questions,
  ScoreQuestion,
} from "@oh-my-pi/pi-ai";
import type { FabricJudgmentLane } from "../judgment/lane.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { actionArgNormalizer } from "./arg-normalization.js";

const askSchema = Type.Object({
  state: Type.Any({
    description:
      "Evidence every question is answered against: a string, or a JSON object/array of named parts.",
  }),
  questions: Type.Record(Type.String(), Type.Any(), {
    description:
      'Questions keyed by id. Each is { type: "choice", instructions, criteria: { label: rubric | null } }, { type: "bool", instructions, criteria?: { true?, false? } }, or { type: "score", instructions, criteria: [lowest, ..., highest] }.',
  }),
}, { additionalProperties: false });

const statsSchema = Type.Object({}, { additionalProperties: false });

const descriptors: FabricActionDescriptor[] = [
  {
    name: "ask",
    description:
      "Answer typed questions about one state with calibrated probabilities: choice (one label plus its distribution), bool (probability of yes), score (weighted position on ordered levels). Questions asked about the same state within the coalesce window travel as one backend request. Returns { ok: false, reason } instead of throwing when no backend is configured, the budget refuses, or the request fails.",
    inputSchema: askSchema.toJsonSchema() as unknown as Record<string, unknown>,
    risk: "network",
  },
  {
    name: "stats",
    description:
      "Counters for this session's judgment lane: requests, batched requests, questions asked, refusals, failures, and the backend that answered last.",
    inputSchema: statsSchema.toJsonSchema() as unknown as Record<string, unknown>,
    risk: "read",
  },
];

const normalizeJudgmentArgs = actionArgNormalizer(() => descriptors);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const instructionsOf = (id: string, value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`judgment.ask question "${id}" needs non-empty string instructions`);
  }
  return value;
};

const parseChoice = (id: string, value: Record<string, unknown>): ChoiceQuestion => {
  const instructions = instructionsOf(id, value.instructions);
  if (!isRecord(value.criteria)) {
    throw new Error(`judgment.ask choice question "${id}" needs criteria: { label: rubric | null }`);
  }
  const criteria: Record<string, string | null> = {};
  for (const label in value.criteria) {
    const rubric = value.criteria[label];
    if (rubric !== null && typeof rubric !== "string") {
      throw new Error(`judgment.ask choice question "${id}" criteria "${label}" must be a string or null`);
    }
    criteria[label] = rubric;
  }
  if (Object.keys(criteria).length < 2) {
    throw new Error(`judgment.ask choice question "${id}" needs at least two options`);
  }
  return { type: "choice", instructions, criteria };
};

const parseBool = (id: string, value: Record<string, unknown>): NoulQuestion => {
  const instructions = instructionsOf(id, value.instructions);
  if (value.criteria === undefined) return { type: "noul", instructions };
  if (!isRecord(value.criteria)) {
    throw new Error(`judgment.ask bool question "${id}" criteria must be { true?: string, false?: string }`);
  }
  const criteria: NonNullable<NoulQuestion["criteria"]> = {};
  for (const side of ["true", "false"] as const) {
    const description = value.criteria[side];
    if (description === undefined) continue;
    if (typeof description !== "string") {
      throw new Error(`judgment.ask bool question "${id}" criteria.${side} must be a string`);
    }
    criteria[side] = description;
  }
  return { type: "noul", instructions, criteria };
};

const parseScore = (id: string, value: Record<string, unknown>): ScoreQuestion => {
  const instructions = instructionsOf(id, value.instructions);
  const levels = value.criteria;
  if (!Array.isArray(levels) || !levels.every((level) => typeof level === "string")) {
    throw new Error(`judgment.ask score question "${id}" needs criteria: [lowest, ..., highest]`);
  }
  const [lowest, second, ...rest] = levels as string[];
  if (lowest === undefined || second === undefined) {
    throw new Error(`judgment.ask score question "${id}" needs at least two levels`);
  }
  return { type: "score", instructions, criteria: [lowest, second, ...rest] };
};

const parseQuestion = (id: string, value: unknown): Question => {
  if (!isRecord(value)) throw new Error(`judgment.ask question "${id}" must be an object`);
  switch (value.type) {
    case "choice":
      return parseChoice(id, value);
    case "bool":
      return parseBool(id, value);
    case "score":
      return parseScore(id, value);
    default:
      throw new Error(`judgment.ask question "${id}" type must be "choice", "bool", or "score"`);
  }
};

const parseState = (value: unknown): JudgmentState => {
  if (typeof value === "string") {
    if (value.length === 0) throw new Error("judgment.ask state must not be empty");
    return value;
  }
  if (Array.isArray(value) || isRecord(value)) return value as JudgmentState;
  throw new Error("judgment.ask state must be a string, a JSON object, or a JSON array");
};

interface AskArguments {
  state: unknown;
  questions: Record<string, unknown>;
}

const checked = <T>(action: string, schema: { toJsonSchema(): unknown }, args: Record<string, unknown>): T => {
  const validation = validateJsonSchemaValue(schema.toJsonSchema() as Record<string, unknown>, args);
  if (!validation.success) {
    const message = validation.issues.slice(0, 5).map((issue) => issue.message).join("; ");
    throw new Error(`Invalid judgment.${action} arguments: ${message}`);
  }
  return args as T;
};

export class JudgmentProvider implements FabricProvider {
  readonly name = "judgment";
  readonly description =
    "Typed judgments over one state: calibrated choice, bool, and score answers batched into one backend request";

  constructor(private readonly lane: FabricJudgmentLane) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    return normalizeJudgmentArgs(actionName, args);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "ask": {
        const input = checked<AskArguments>("ask", askSchema, args);
        const state = parseState(input.state);
        const questions: Questions = {};
        for (const id in input.questions) questions[id] = parseQuestion(id, input.questions[id]);
        const outcome = await this.lane.ask(state, questions, {
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        });
        if (!outcome.ok) return outcome;
        const answers: Record<string, unknown> = {};
        for (const id in outcome.answers) {
          const answer = outcome.answers[id]!;
          answers[id] = answer.type === "noul" ? { type: "bool", bool: answer.noul } : answer;
        }
        return { ok: true, backend: outcome.backend, answers };
      }
      case "stats":
        return { enabled: this.lane.enabled, ...this.lane.stats() };
      default:
        throw new Error(`Unknown judgment action: ${actionName}`);
    }
  }
}
