/** Tracks rendered fabric_exec cards so a display preference switch redraws the current transcript. */
export class FabricToolDisplayController {
  readonly #invalidators = new Map<string, {
    call?: () => void;
    result?: () => void;
  }>();
  #pendingRefresh: Array<() => void> = [];
  #refreshDrainScheduled = false;

  observe(
    toolCallId: string,
    kind: "call" | "result",
    invalidate: () => void,
  ): void {
    const invalidators = this.#invalidators.get(toolCallId) ?? {};
    invalidators[kind] = invalidate;
    this.#invalidators.set(toolCallId, invalidators);
  }

  refresh(): void {
    for (const { call, result } of this.#invalidators.values()) {
      // A card's call and result invalidators resolve to the same host
      // component: its invalidate() re-renders both renderers together, so one
      // call covers the whole card and calling both would double the work.
      const invalidate = result ?? call;
      if (invalidate) this.#pendingRefresh.push(invalidate);
    }
    this.#scheduleRefreshDrain();
  }

  // Drain a few cards per event-loop turn. invalidate() synchronously runs the
  // card's full renderer pair (updateDisplay in OMP's ToolExecutionComponent),
  // so re-rendering a long transcript inside a single keypress froze the UI
  // until every card had been redrawn.
  #scheduleRefreshDrain(): void {
    if (this.#refreshDrainScheduled) return;
    this.#refreshDrainScheduled = true;
    setImmediate(() => {
      this.#refreshDrainScheduled = false;
      const batch = this.#pendingRefresh.splice(0, REFRESH_CARDS_PER_TICK);
      for (const invalidate of batch) {
        try {
          invalidate();
        } catch {
          // A transcript component may already have been disposed.
        }
      }
      if (this.#pendingRefresh.length > 0) this.#scheduleRefreshDrain();
    });
  }

  clear(): void {
    this.#pendingRefresh = [];
    this.#invalidators.clear();
  }
}

// Cards re-rendered per event-loop turn during refresh(): small enough that
// one drain tick stays well inside a frame, large enough that realistic
// transcripts finish repainting within a handful of turns.
const REFRESH_CARDS_PER_TICK = 3;
