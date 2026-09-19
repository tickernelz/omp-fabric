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
  done: boolean;
}

interface PendingBatch {
  state: JudgmentState;
  entries: PendingEntry[];
  questionCount: number;
  timer?: ReturnType<typeof setTimeout>;
}

const stateKey = (state: JudgmentState): string =>
  typeof state === "string" ? `s:${state}` : `j:${JSON.stringify(state)}`;

const stateBytes = (state: JudgmentState): number =>
  Buffer.byteLength(typeof state === "string" ? state : JSON.stringify(state), "utf-8");

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Batches typed judgments over one state into a single backend request.
 * Never rejects: a missing backend, a refused budget, or a failed request all resolve `{ ok: false }`.
 */
export class FabricJudgmentLane {
  readonly #config: FabricJudgmentConfig;
  readonly #resolve: JudgeResolver;
  readonly #pending = new Map<string, PendingBatch>();
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
  #judge: Judge | undefined;
  #judgeResolved = false;

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
    if (ids.length === 0) {
      this.#stats.refusals++;
      return { ok: false, reason: "refused", detail: "no questions" };
    }
    if (ids.length > this.#config.maxQuestionsPerRequest) {
      this.#stats.refusals++;
      return {
        ok: false,
        reason: "refused",
        detail: `${ids.length} questions exceeds maxQuestionsPerRequest=${this.#config.maxQuestionsPerRequest}`,
      };
    }
    const bytes = stateBytes(state);
    if (bytes > this.#config.maxStateBytes) {
      this.#stats.refusals++;
      return {
        ok: false,
        reason: "refused",
        detail: `state of ${bytes} bytes exceeds maxStateBytes=${this.#config.maxStateBytes}`,
      };
    }
    if (options?.signal?.aborted === true) return { ok: false, reason: "aborted" };

    const outcome = await new Promise<JudgmentOutcome>((settle) => {
      this.#enqueue(state, questions, settle, options?.signal);
    });
    return outcome as JudgmentOutcome<Q>;
  }

  #enqueue(
    state: JudgmentState,
    questions: Questions,
    settle: (outcome: JudgmentOutcome) => void,
    signal: AbortSignal | undefined,
  ): void {
    const key = stateKey(state);
    const asked = Object.keys(questions).length;
    const existing = this.#pending.get(key);
    if (existing && existing.questionCount + asked > this.#config.maxQuestionsPerRequest) {
      this.#flush(key);
    }
    const batch = this.#pending.get(key) ?? { state, entries: [], questionCount: 0 };
    const entry: PendingEntry = { prefix: `q${this.#sequence++}`, questions, settle, done: false };
    signal?.addEventListener("abort", () => this.#settle(entry, { ok: false, reason: "aborted" }), {
      once: true,
    });
    batch.entries.push(entry);
    batch.questionCount += asked;
    this.#pending.set(key, batch);
    if (batch.questionCount >= this.#config.maxQuestionsPerRequest) {
      this.#flush(key);
      return;
    }
    if (batch.timer === undefined) {
      batch.timer = setTimeout(() => this.#flush(key), this.#config.coalesceMs);
      batch.timer.unref?.();
    }
  }

  #flush(key: string): void {
    const batch = this.#pending.get(key);
    if (!batch) return;
    this.#pending.delete(key);
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    const live = batch.entries.filter((entry) => !entry.done);
    if (live.length === 0) return;
    void this.#run(batch.state, live);
  }

  async #run(state: JudgmentState, entries: PendingEntry[]): Promise<void> {
    const merged: Questions = {};
    for (const entry of entries) {
      for (const id in entry.questions) {
        merged[`${entry.prefix}_${id}`] = entry.questions[id]!;
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#config.timeoutMs);
    timer.unref?.();
    try {
      const judge = await this.#backend();
      if (!judge) {
        this.#settleAll(entries, { ok: false, reason: "unsupported" });
        return;
      }
      this.#stats.requests++;
      this.#stats.questions += Object.keys(merged).length;
      if (entries.length > 1) {
        this.#stats.batched++;
        this.#stats.merged += entries.length;
      }
      const result = await judge.judge({ state, questions: merged }, { signal: controller.signal });
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
      clearTimeout(timer);
    }
  }

  #settle(entry: PendingEntry, outcome: JudgmentOutcome): void {
    if (entry.done) return;
    entry.done = true;
    entry.settle(outcome);
  }

  #settleAll(entries: PendingEntry[], outcome: JudgmentOutcome): void {
    for (const entry of entries) this.#settle(entry, outcome);
  }

  async #backend(): Promise<Judge | undefined> {
    if (this.#judgeResolved) return this.#judge;
    try {
      this.#judge = await this.#resolve();
    } catch (error) {
      this.#stats.lastError = errorText(error);
      this.#judge = undefined;
    }
    this.#judgeResolved = true;
    return this.#judge;
  }
}
