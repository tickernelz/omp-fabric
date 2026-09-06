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

type CompactCommitStatus = "committed" | "cancelled" | "failed";


export interface CompactLastCommit {
  at: number;
  requestedBy: string;
  status: CompactCommitStatus;
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
}

export interface CompactStatus {
  pending?: CompactPendingIntent;
  last?: CompactLastCommit;
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

export class CompactController {
  #pending: CompactPendingIntent | undefined;
  #last: CompactLastCommit | undefined;
  #inFlight: Promise<void> | undefined;
  readonly #hooks: CompactControllerHooks;

  constructor(hooks: CompactControllerHooks = {}) {
    this.#hooks = hooks;
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

  status(): CompactStatus {
    return {
      ...(this.#pending ? { pending: this.#pending } : {}),
      ...(this.#last ? { last: this.#last } : {}),
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
    const completion = (async (): Promise<void> => {
      try {
        await context.compact(instructions);
        clearCommittedIntent();
        this.#last = { at: Date.now(), requestedBy, status: "committed" };
        this.#hooks.onCommit?.(this.#last);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Compaction failed";
        clearCommittedIntent();
        const cancelled = message === "Compaction cancelled" || message === "Already compacted";
        this.#last = {
          at: Date.now(),
          requestedBy,
          status: cancelled ? "cancelled" : "failed",
          error: message,
        };
        this.#hooks.onCommit?.(this.#last);
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
