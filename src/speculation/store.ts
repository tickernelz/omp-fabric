import { stableJsonHash } from "../core/stable-hash.js";
import type { FabricFreshnessChecker } from "./freshness.js";
import type {
  FabricSpeculationConfig,
  FabricSpeculationReplay,
  FabricSpeculationRuntime,
  FabricSpeculationServeResult,
  FabricSpeculationStats,
} from "./types.js";

interface SpeculationEntry {
  parentToolCallId: string;
  ref: string;
  birthEpoch: number;
  createdAt: number;
  controller: AbortController;
  freshness: FabricFreshnessChecker | undefined;
  replay: FabricSpeculationReplay;
  promise: Promise<unknown>;
  failed: boolean;
}

/**
 * Turn-scoped store of pre-launched speculation promises.
 *
 * Correctness contract: a stored promise may only be served to a real call
 * when (1) the mutation epoch has not advanced since the speculation launched
 * — the epoch bumps after any real in-program invocation whose effect kind is
 * not "none" — (2) the entry's freshness checker, when present, still holds,
 * and (3) the entry was launched against the same provider binding the real
 * call resolved: the binding token is part of the cache key, so an entry that
 * a reset could not abort (its speculate() was still mid-describe when the
 * binding was replaced) can never match the replacement's serve key. Entries
 * are take-once (identical duplicate calls each need their own speculation)
 * and are aborted + counted wasted when their execution finishes without
 * serving them or when the turn resets.
 */
export class FabricSpeculationStore implements FabricSpeculationRuntime {
  #epoch = 0;
  readonly #entries = new Map<string, SpeculationEntry>();
  readonly #stats: FabricSpeculationStats = {
    launched: 0,
    served: 0,
    absent: 0,
    epochInvalidated: 0,
    freshnessInvalidated: 0,
    failed: 0,
    wasted: 0,
    skipped: 0,
  };
  readonly #maxConcurrent: number;
  readonly #maxEntries: number;
  readonly #entryTtlMs: number;
  readonly #launching = new Map<string, { count: number; waiters: (() => void)[] }>();

  constructor(config: Pick<FabricSpeculationConfig, "maxConcurrent" | "maxEntries" | "entryTtlMs">) {
    this.#maxConcurrent = config.maxConcurrent;
    this.#maxEntries = config.maxEntries;
    this.#entryTtlMs = config.entryTtlMs;
  }

  get epoch(): number {
    return this.#epoch;
  }

  stats(): FabricSpeculationStats & { pending: number } {
    return { ...this.#stats, pending: this.#entries.size };
  }

  bumpEpoch(): void {
    this.#epoch += 1;
  }

  static key(
    parentToolCallId: string,
    ref: string,
    preparedArgs: Record<string, unknown>,
    bindingToken: string,
  ): string {
    return `${parentToolCallId}\n${ref}\n${stableJsonHash(preparedArgs)}\n${bindingToken}`;
  }

  beginLaunch(parentToolCallId: string): () => void {
    const pending = this.#launching.get(parentToolCallId) ?? { count: 0, waiters: [] };
    pending.count += 1;
    this.#launching.set(parentToolCallId, pending);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending.count -= 1;
      if (pending.count > 0) return;
      this.#launching.delete(parentToolCallId);
      for (const waiter of pending.waiters.splice(0)) waiter();
    };
  }

  async settleLaunches(parentToolCallId: string, timeoutMs: number): Promise<void> {
    const pending = this.#launching.get(parentToolCallId);
    if (!pending || pending.count === 0) return;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      pending.waiters.push(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  /**
   * Register and start a speculative invocation. Returns false when at
   * capacity; the candidate is dropped silently (a miss costs nothing, the
   * real call executes normally later).
   */
  launch(
    parentToolCallId: string,
    ref: string,
    preparedArgs: Record<string, unknown>,
    execute: (signal: AbortSignal) => Promise<unknown>,
    freshness: FabricFreshnessChecker | undefined,
    replay: FabricSpeculationReplay,
    bindingToken: string,
  ): boolean {
    this.#releaseLaunch(parentToolCallId);
    this.#sweepExpired(Date.now());
    if (this.#entries.size >= this.#maxEntries || this.#inFlightCount() >= this.#maxConcurrent) {
      this.#stats.skipped += 1;
      return false;
    }
    const key = FabricSpeculationStore.key(parentToolCallId, ref, preparedArgs, bindingToken);
    if (this.#entries.has(key)) {
      this.#stats.skipped += 1;
      return false;
    }
    const controller = new AbortController();
    const entry: SpeculationEntry = {
      parentToolCallId,
      ref,
      birthEpoch: this.#epoch,
      createdAt: Date.now(),
      controller,
      freshness,
      replay,
      promise: Promise.resolve()
        .then(() => execute(controller.signal))
        .catch(() => {
          entry.failed = true;
          return undefined;
        }),
      failed: false,
    };
    // Promise.resolve().then keeps a synchronous executor throw inside the
    // entry (failed flag) rather than at the launch site.
    this.#entries.set(key, entry);
    this.#stats.launched += 1;
    return true;
  }

  async tryServe(
    parentToolCallId: string,
    ref: string,
    preparedArgs: Record<string, unknown>,
    bindingToken: string,
  ): Promise<FabricSpeculationServeResult> {
    const key = FabricSpeculationStore.key(parentToolCallId, ref, preparedArgs, bindingToken);
    const entry = this.#entries.get(key);
    if (!entry || entry.parentToolCallId !== parentToolCallId) {
      this.#stats.absent += 1;
      return { hit: false, reason: "absent" };
    }
    this.#entries.delete(key);
    if (entry.birthEpoch !== this.#epoch) {
      this.#stats.epochInvalidated += 1;
      entry.controller.abort();
      return { hit: false, reason: "epoch" };
    }
    if (entry.freshness && !entry.freshness()) {
      this.#stats.freshnessInvalidated += 1;
      entry.controller.abort();
      return { hit: false, reason: "freshness" };
    }
    const value = await entry.promise;
    if (entry.failed) {
      this.#stats.failed += 1;
      return { hit: false, reason: "failed" };
    }
    this.#stats.served += 1;
    return { hit: true, value, replay: entry.replay };
  }

  /** Execution for this tool call finished: everything unserved is waste. */
  onInvocationEnd(parentToolCallId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.parentToolCallId !== parentToolCallId) continue;
      entry.controller.abort();
      this.#entries.delete(key);
      this.#stats.wasted += 1;
    }
  }

  /** Turn backstop: speculation never outlives a turn. */
  reset(): void {
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
    for (const pending of this.#launching.values()) {
      pending.count = 0;
      for (const waiter of pending.waiters.splice(0)) waiter();
    }
    this.#launching.clear();
  }

  #releaseLaunch(parentToolCallId: string): void {
    const pending = this.#launching.get(parentToolCallId);
    if (!pending) return;
    pending.count -= 1;
    if (pending.count > 0) return;
    this.#launching.delete(parentToolCallId);
    for (const waiter of pending.waiters.splice(0)) waiter();
  }

  #inFlightCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (!entry.failed) count += 1;
    }
    return count;
  }

  #sweepExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.createdAt <= this.#entryTtlMs) continue;
      entry.controller.abort();
      this.#entries.delete(key);
      this.#stats.wasted += 1;
    }
  }
}
