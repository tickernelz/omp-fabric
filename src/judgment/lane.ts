import type { AnswerFor, Judge, JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import type { FabricJudgmentConfig } from "../config.js";

type JudgmentAnswers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };

type JudgmentRefusal =
  | "disabled"
  | "unsupported"
  | "refused"
  | "failed"
  | "timeout"
  | "aborted";

export type JudgmentOutcome<Q extends Questions = Questions> =
  | { ok: true; answers: JudgmentAnswers<Q>; backend: string }
  | { ok: false; reason: JudgmentRefusal; detail?: string };

export type JudgeResolver = () => Promise<Judge | undefined>;

export interface JudgmentAskOptions {
  signal?: AbortSignal;
}

export interface JudgmentLaneStats {
  requests: number;
  batched: number;
  questions: number;
  merged: number;
  failures: number;
  refusals: number;
  timeouts: number;
  lastBackend?: string;
  lastError?: string;
}

interface PendingEntry {
  prefix: string;
  questions: Questions;
  settle: (outcome: JudgmentOutcome) => void;
  detach?: () => void;
  done: boolean;
}

interface PendingBatch {
  state: JudgmentState;
  entries: PendingEntry[];
  questionCount: number;
  timer?: ReturnType<typeof setTimeout>;
}

class DeadlineError extends Error {}

const measure = (state: JudgmentState): { key: string; bytes: number } | undefined => {
  try {
    const serialized = typeof state === "string" ? state : JSON.stringify(state);
    if (typeof serialized !== "string") return undefined;
    return { key: typeof state === "string" ? `s:${serialized}` : `j:${serialized}`, bytes: Buffer.byteLength(serialized, "utf-8") };
  } catch {
    return undefined;
  }
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Batches typed judgments over one state into a single backend request.
 * Never rejects: a missing backend, a refused budget, a blown deadline and a caller abort all resolve `{ ok: false }`.
 */
export class FabricJudgmentLane {
  readonly #config: FabricJudgmentConfig;
  readonly #resolve: JudgeResolver;
  readonly #pending = new Map<string, PendingBatch>();
  readonly #waiting: Array<() => void> = [];
  readonly #stats: JudgmentLaneStats = {
    requests: 0,
    batched: 0,
    questions: 0,
    merged: 0,
    failures: 0,
    refusals: 0,
    timeouts: 0,
  };
  #sequence = 0;
  #inFlight = 0;
  #judge: Judge | undefined;
  #judgeResolved = false;
  #judgePromise: Promise<Judge | undefined> | undefined;
  #resolveError: string | undefined;

  constructor(config: FabricJudgmentConfig, resolve: JudgeResolver) {
    this.#config = config;
    this.#resolve = resolve;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  stats(): JudgmentLaneStats {
    return { ...this.#stats };
  }

  async ask<Q extends Questions>(
    state: JudgmentState,
    questions: Q,
    options?: JudgmentAskOptions,
  ): Promise<JudgmentOutcome<Q>> {
    const ids = Object.keys(questions);
    if (!this.#config.enabled) return { ok: false, reason: "disabled" };
    if (ids.length === 0) return this.#refuse("no questions");
    if (ids.length > this.#config.maxQuestionsPerRequest) {
      return this.#refuse(
        `${ids.length} questions exceeds maxQuestionsPerRequest=${this.#config.maxQuestionsPerRequest}`,
      );
    }
    const measured = measure(state);
    if (!measured) return this.#refuse("state is not JSON-encodable");
    if (measured.bytes > this.#config.maxStateBytes) {
      return this.#refuse(
        `state of ${measured.bytes} bytes exceeds maxStateBytes=${this.#config.maxStateBytes}`,
      );
    }
    if (options?.signal?.aborted === true) return { ok: false, reason: "aborted" };

    const outcome = await new Promise<JudgmentOutcome>((settle) => {
      this.#enqueue(measured.key, state, questions, settle, options?.signal);
    });
    return outcome as JudgmentOutcome<Q>;
  }

  #refuse(detail: string): { ok: false; reason: "refused"; detail: string } {
    this.#stats.refusals++;
    return { ok: false, reason: "refused", detail };
  }

  #enqueue(
    key: string,
    state: JudgmentState,
    questions: Questions,
    settle: (outcome: JudgmentOutcome) => void,
    signal: AbortSignal | undefined,
  ): void {
    const asked = Object.keys(questions).length;
    const existing = this.#pending.get(key);
    if (existing && existing.questionCount + asked > this.#config.maxQuestionsPerRequest) {
      this.#flush(key);
    }
    const batch = this.#pending.get(key) ?? { state, entries: [], questionCount: 0 };
    const entry: PendingEntry = { prefix: `q${this.#sequence++}`, questions, settle, done: false };
    if (signal) {
      const onAbort = (): void => this.#settle(entry, { ok: false, reason: "aborted" });
      entry.detach = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    batch.entries.push(entry);
    batch.questionCount += asked;
    this.#pending.set(key, batch);
    if (batch.questionCount >= this.#config.maxQuestionsPerRequest) {
      this.#flush(key);
      return;
    }
    batch.timer ??= setTimeout(() => this.#flush(key), this.#config.coalesceMs);
  }

  #flush(key: string): void {
    const batch = this.#pending.get(key);
    if (!batch) return;
    this.#pending.delete(key);
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    const live = batch.entries.filter((entry) => !entry.done);
    if (live.length === 0) return;
    void this.#schedule(batch.state, live);
  }

  /** Holds a slot for the whole run and hands it to the next waiter, so a flush cannot take one mid-release. */
  async #schedule(state: JudgmentState, entries: PendingEntry[]): Promise<void> {
    if (this.#inFlight >= this.#config.maxConcurrent) {
      await new Promise<void>((release) => this.#waiting.push(release));
    } else {
      this.#inFlight++;
    }
    try {
      const live = entries.filter((entry) => !entry.done);
      if (live.length > 0) await this.#run(state, live);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#inFlight--;
    }
  }

  async #run(state: JudgmentState, entries: PendingEntry[]): Promise<void> {
    const merged: Questions = {};
    for (const entry of entries) {
      for (const id in entry.questions) {
        merged[`${entry.prefix}_${id}`] = entry.questions[id]!;
      }
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_settle, fail) => {
      timer = setTimeout(() => {
        timedOut = true;
        fail(new DeadlineError(`no answer within ${this.#config.timeoutMs}ms`));
        controller.abort();
      }, this.#config.timeoutMs);
    });
    deadline.catch(() => {});
    try {
      const judge = await Promise.race([this.#backend(), deadline]);
      if (!judge) {
        this.#settleAll(entries, {
          ok: false,
          reason: "unsupported",
          ...(this.#resolveError !== undefined ? { detail: this.#resolveError } : {}),
        });
        return;
      }
      this.#stats.requests++;
      this.#stats.questions += Object.keys(merged).length;
      if (entries.length > 1) {
        this.#stats.batched++;
        this.#stats.merged += entries.length;
      }
      const pending = judge.judge({ state, questions: merged }, { signal: controller.signal });
      pending.catch(() => {});
      const result = await Promise.race([pending, deadline]);
      const backend = `${result.provider}/${result.model}`;
      this.#stats.lastBackend = backend;
      for (const entry of entries) {
        const answers: Record<string, unknown> = {};
        let missing: string | undefined;
        for (const id in entry.questions) {
          const answer = result.answers[`${entry.prefix}_${id}`];
          if (answer === undefined) {
            missing = id;
            break;
          }
          answers[id] = answer;
        }
        this.#settle(
          entry,
          missing === undefined
            ? { ok: true, answers: answers as JudgmentAnswers<Questions>, backend }
            : { ok: false, reason: "failed", detail: `no answer for "${missing}"` },
        );
      }
    } catch (error) {
      const detail = timedOut ? `no answer within ${this.#config.timeoutMs}ms` : errorText(error);
      if (timedOut) this.#stats.timeouts++;
      else this.#stats.failures++;
      this.#stats.lastError = detail;
      this.#settleAll(entries, { ok: false, reason: timedOut ? "timeout" : "failed", detail });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #settle(entry: PendingEntry, outcome: JudgmentOutcome): void {
    if (entry.done) return;
    entry.done = true;
    entry.detach?.();
    entry.settle(outcome);
  }

  #settleAll(entries: PendingEntry[], outcome: JudgmentOutcome): void {
    for (const entry of entries) this.#settle(entry, outcome);
  }

  /** Resolves once per session, including a host that offers no judge; only a thrown resolver is retried. */
  async #backend(): Promise<Judge | undefined> {
    if (this.#judgeResolved) return this.#judge;
    this.#judgePromise ??= this.#resolve().then(
      (judge) => {
        this.#judge = judge;
        this.#judgeResolved = true;
        this.#resolveError = undefined;
        this.#judgePromise = undefined;
        return judge;
      },
      (error) => {
        this.#resolveError = errorText(error);
        this.#stats.lastError = this.#resolveError;
        this.#judgePromise = undefined;
        return undefined;
      },
    );
    return this.#judgePromise;
  }
}
