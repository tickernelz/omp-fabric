const EVENT_LOOP_SLICE_MS = 20;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Tracks one synchronous run of work and hands the event loop back once it exceeds its budget. */
export class EventLoopSlice {
  #started = performance.now();
  #yields = 0;

  constructor(private readonly budgetMs = EVENT_LOOP_SLICE_MS) {}

  get due(): boolean { return performance.now() - this.#started >= this.budgetMs; }
  get yields(): number { return this.#yields; }

  async yield(): Promise<void> {
    this.#yields += 1;
    await yieldToEventLoop();
    this.#started = performance.now();
  }

  async pause(): Promise<void> { if (this.due) await this.yield(); }
}
