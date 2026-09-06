import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  compactionRequestBoundsError,
  encodeCompactionRequest,
} from "../compaction/instructions.js";

// A pending-intent controller for the host OMP session's context compaction.
//
// Compaction here is a deliberate, advisory-then-committed act: the model (or a
// skill) requests a compaction by calling `request()`, which only records the
// *intent*. The host commits it later at a safe boundary — `agent_end`,
// never mid-turn and never while a turn is in flight — by calling
// `maybeCommit(context)`, which forwards to `ExtensionContext.compact()`.
//
// This mirrors Schema's harness-enforced gate: there is exactly one write path
// from thought (intent) to action (commit), and the host — not the model —
// decides when it is safe. The model cannot compact the running context
// directly; it can only ask, and the ask is a single replaceable slot.

export interface CompactRequestIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy?: string;
}

export interface CompactPendingIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy: string;
  requestedAt: number;
}

type CompactCommitStatus = "committed" | "cancelled" | "failed" | "skipped";


export interface CompactLastCommit {
  at: number;
  requestedBy: string;
  status: CompactCommitStatus;
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
  persisted?: boolean;
}

interface CompactContextUsage {
  known: boolean;
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  remainingTokens: number | null;
}

interface CompactSettings {
  engine: string;
  targetContextRatio: number;
}

export interface CompactOutcomeStore {
  load(sessionId: string): CompactLastCommit | undefined;
  save(sessionId: string, outcome: CompactLastCommit): void;
}

export interface CompactControllerOptions {
  settings?: () => CompactSettings;
  outcomes?: CompactOutcomeStore;
}

export interface CompactStatus {
  pending?: CompactPendingIntent;
  last?: CompactLastCommit;
  context?: CompactContextUsage;
  engine?: string;
  targetContextRatio?: number;
  model?: string;
  sessionId?: string;
}

export interface CompactControllerHooks {
  // Fired when a new intent is recorded (request replaces any pending one).
  onRequest?: (intent: CompactPendingIntent) => void;
  // Fired when the host settles a recorded intent: "committed" after the OMP
  // compaction promise resolves, "cancelled" for an expected cancellation, and
  // "failed" for any other error.
  onCommit?: (info: CompactLastCommit) => void;
}

const DEFAULT_REQUESTED_BY = "model";

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const checkedPreserve = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("compact preserve must be an array of strings");
  }
  return [...value];
};

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const UNKNOWN_USAGE: CompactContextUsage = {
  known: false,
  tokens: null,
  contextWindow: null,
  percent: null,
  remainingTokens: null,
};

const readCompactContextUsage = (
  context: Pick<ExtensionContext, "getContextUsage" | "model"> | undefined,
): CompactContextUsage => {
  const modelWindow = finite(context?.model?.contextWindow);
  let usage: ReturnType<ExtensionContext["getContextUsage"]>;
  try {
    usage = context?.getContextUsage?.();
  } catch {
    usage = undefined;
  }
  if (!usage) return { ...UNKNOWN_USAGE, contextWindow: modelWindow };
  const tokens = finite(usage.tokens);
  const contextWindow = finite(usage.contextWindow) ?? modelWindow;
  const percent = finite(usage.percent)
    ?? (tokens !== null && contextWindow !== null && contextWindow > 0
      ? (tokens / contextWindow) * 100
      : null);
  return {
    known: tokens !== null || percent !== null,
    tokens,
    contextWindow,
    percent,
    remainingTokens: tokens !== null && contextWindow !== null
      ? Math.max(0, contextWindow - tokens)
      : null,
  };
};

const sessionIdOf = (context: ExtensionContext | undefined): string | undefined => {
  try {
    const id = context?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
};

export class CompactController {
  #pending: CompactPendingIntent | undefined;
  #last: CompactLastCommit | undefined;
  #inFlight: Promise<void> | undefined;
  #restoredFor: string | undefined;
  #restored: CompactLastCommit | undefined;
  readonly #hooks: CompactControllerHooks;
  readonly #options: CompactControllerOptions;

  constructor(hooks: CompactControllerHooks = {}, options: CompactControllerOptions = {}) {
    this.#hooks = hooks;
    this.#options = options;
  }

  // Record a pending compaction intent. A single slot: a new request replaces
  // any pending one, keeping the latest instructions.
  request(intent: CompactRequestIntent): CompactPendingIntent {
    const preserve = checkedPreserve(intent.preserve);
    const request = {
      ...(intent.instructions !== undefined ? { instructions: intent.instructions } : {}),
      ...(preserve !== undefined ? { preserve } : {}),
    };
    const boundsError = compactionRequestBoundsError(request);
    if (boundsError) throw new Error(boundsError.message);
    if (preserve !== undefined) encodeCompactionRequest(request);
    const pending: CompactPendingIntent = {
      requestedBy: isString(intent.requestedBy) ? intent.requestedBy! : DEFAULT_REQUESTED_BY,
      requestedAt: Date.now(),
      ...(isString(intent.reason) ? { reason: intent.reason } : {}),
      ...(isString(intent.instructions) ? { instructions: intent.instructions } : {}),
      ...(preserve !== undefined ? { preserve } : {}),
    };
    this.#pending = pending;
    this.#hooks.onRequest?.(pending);
    return pending;
  }

  // Clear a pending intent without committing. Safe to call when nothing is
  // pending.
  cancel(): void {
    this.#pending = undefined;
  }

  #settledOutcome(context: ExtensionContext | undefined): CompactLastCommit | undefined {
    if (this.#last) return this.#last;
    const store = this.#options.outcomes;
    if (!store) return undefined;
    const sessionId = sessionIdOf(context);
    if (sessionId === undefined) return undefined;
    if (this.#restoredFor !== sessionId) {
      this.#restoredFor = sessionId;
      this.#restored = store.load(sessionId);
    }
    return this.#restored;
  }

  #settle(context: ExtensionContext, outcome: CompactLastCommit): void {
    this.#last = outcome;
    this.#restoredFor = undefined;
    this.#restored = undefined;
    const store = this.#options.outcomes;
    const sessionId = store ? sessionIdOf(context) : undefined;
    if (store && sessionId !== undefined) store.save(sessionId, outcome);
    this.#hooks.onCommit?.(outcome);
  }

  status(context?: ExtensionContext): CompactStatus {
    const settings = this.#options.settings?.();
    const last = this.#settledOutcome(context);
    const model = context?.model;
    const sessionId = sessionIdOf(context);
    return {
      ...(this.#pending ? { pending: this.#pending } : {}),
      ...(last ? { last } : {}),
      context: readCompactContextUsage(context),
      ...(settings
        ? { engine: settings.engine, targetContextRatio: settings.targetContextRatio }
        : {}),
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  async maybeCommit(context: ExtensionContext): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const pending = this.#pending;
    if (!pending) return;

    const requestedBy = pending.requestedBy;
    const instructions = pending.preserve
      ? encodeCompactionRequest({
          ...(pending.instructions !== undefined ? { instructions: pending.instructions } : {}),
          preserve: pending.preserve,
        })
      : pending.instructions;
    const committing = pending;
    const clearCommittedIntent = (): void => {
      if (this.#pending === committing) this.#pending = undefined;
    };
    const before = readCompactContextUsage(context);
    const completion = (async (): Promise<void> => {
      try {
        await context.compact(instructions);
        clearCommittedIntent();
        const after = readCompactContextUsage(context);
        const measured = before.tokens !== null && after.tokens !== null;
        this.#settle(context, {
          at: Date.now(),
          requestedBy,
          status: measured && after.tokens! >= before.tokens! ? "skipped" : "committed",
          ...(before.tokens !== null ? { tokensBefore: before.tokens } : {}),
          ...(after.tokens !== null ? { estimatedTokensAfter: after.tokens } : {}),
          ...(measured && after.tokens! >= before.tokens!
            ? { error: "Compaction ran but freed no context tokens" }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Compaction failed";
        clearCommittedIntent();
        const cancelled = message === "Compaction cancelled" || message === "Already compacted";
        this.#settle(context, {
          at: Date.now(),
          requestedBy,
          status: cancelled ? "cancelled" : "failed",
          ...(before.tokens !== null ? { tokensBefore: before.tokens } : {}),
          error: message,
        });
      }
    })();
    this.#inFlight = completion;
    try {
      await completion;
    } finally {
      if (this.#inFlight === completion) this.#inFlight = undefined;
    }
  }
}
