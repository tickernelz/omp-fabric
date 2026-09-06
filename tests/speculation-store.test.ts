import { describe, expect, it, vi } from "vitest";
import { FabricSpeculationStore } from "../src/speculation/store.js";

const makeStore = () =>
  new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("FabricSpeculationStore", () => {
  it("serves a landed speculation exactly once", async () => {
    const store = makeStore();
    const call = deferred<string>();
    const executor = vi.fn(() => call.promise);
    expect(store.launch("tc1", "omp.read", { path: "a.ts" }, executor, undefined, {}, "b1")).toBe(true);
    call.resolve("contents");
    const served = await store.tryServe("tc1", "omp.read", { path: "a.ts" }, "b1");
    expect(served).toEqual({ hit: true, value: "contents", replay: {} });
    // Take-once: the identical second call must miss.
    expect((await store.tryServe("tc1", "omp.read", { path: "a.ts" }, "b1")).hit).toBe(false);
    expect(store.stats()).toMatchObject({ launched: 1, served: 1 });
  });

  it("awaits an in-flight speculation", async () => {
    const store = makeStore();
    const call = deferred<string>();
    store.launch("tc1", "omp.read", { path: "a.ts" }, () => call.promise, undefined, {}, "b1");
    const serving = store.tryServe("tc1", "omp.read", { path: "a.ts" }, "b1");
    call.resolve("late");
    expect(await serving).toEqual({ hit: true, value: "late", replay: {} });
  });

  it("misses when the mutation epoch advanced after launch", async () => {
    const store = makeStore();
    store.launch("tc1", "omp.read", { path: "a.ts" }, () => Promise.resolve("x"), undefined, {}, "b1");
    store.bumpEpoch();
    const served = await store.tryServe("tc1", "omp.read", { path: "a.ts" }, "b1");
    expect(served).toEqual({ hit: false, reason: "epoch" });
    expect(store.stats().epochInvalidated).toBe(1);
  });

  it("misses when the freshness checker no longer holds", async () => {
    const store = makeStore();
    let fresh = true;
    store.launch(
      "tc1",
      "omp.read",
      { path: "a.ts" },
      () => Promise.resolve("x"),
      () => fresh,
      {},
      "b1",
    );
    fresh = false;
    expect(await store.tryServe("tc1", "omp.read", { path: "a.ts" }, "b1")).toEqual({
      hit: false,
      reason: "freshness",
    });
  });

  it("misses when the speculative call failed", async () => {
    const store = makeStore();
    store.launch(
      "tc1",
      "omp.read",
      { path: "gone.ts" },
      () => Promise.reject(new Error("ENOENT")),
      undefined,
      {},
      "b1",
    );
    // Let the entry's internal catch run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.tryServe("tc1", "omp.read", { path: "gone.ts" }, "b1")).toEqual({
      hit: false,
      reason: "failed",
    });
  });

  it("scopes entries to the streaming tool call that produced them", async () => {
    const store = makeStore();
    store.launch("tc1", "omp.read", { path: "a.ts" }, () => Promise.resolve("x"), undefined, {}, "b1");
    expect(await store.tryServe("tc2", "omp.read", { path: "a.ts" }, "b1")).toEqual({
      hit: false,
      reason: "absent",
    });
  });

  it("replay sinks flow to the serve result", async () => {
    const store = makeStore();
    const replay: Record<string, unknown> = {};
    store.launch(
      "tc1",
      "omp.read",
      { path: "a.ts" },
      async () => {
        replay.preview = { renderer: "rich" };
        return "x";
      },
      undefined,
      replay,
      "b1",
    );
    const served = await store.tryServe("tc1", "omp.read", { path: "a.ts" }, "b1");
    expect(served.hit && served.replay.preview).toEqual({ renderer: "rich" });
  });

  it("drops and counts unserved entries when the invocation ends", async () => {
    const store = makeStore();
    store.launch("tc1", "omp.read", { path: "a.ts" }, () => Promise.resolve("x"), undefined, {}, "b1");
    store.launch("tc1", "omp.read", { path: "b.ts" }, () => Promise.resolve("y"), undefined, {}, "b1");
    store.onInvocationEnd("tc1");
    expect(store.stats()).toMatchObject({ wasted: 2, pending: 0 });
  });

  it("respects the entries cap", () => {
    const store = new FabricSpeculationStore({ maxConcurrent: 100, maxEntries: 1, entryTtlMs: 60_000 });
    expect(
      store.launch("tc1", "omp.read", { path: "a.ts" }, () => Promise.resolve("x"), undefined, {}, "b1"),
    ).toBe(true);
    expect(
      store.launch("tc1", "omp.read", { path: "b.ts" }, () => Promise.resolve("y"), undefined, {}, "b1"),
    ).toBe(false);
    expect(store.stats().skipped).toBe(1);
  });

  it("sweeps expired entries on the next launch", async () => {
    vi.useFakeTimers();
    try {
      const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 1_000 });
      store.launch("tc1", "omp.read", { path: "a.ts" }, () => Promise.resolve("x"), undefined, {}, "b1");
      vi.advanceTimersByTime(2_000);
      store.launch("tc1", "omp.read", { path: "b.ts" }, () => Promise.resolve("y"), undefined, {}, "b1");
      expect(store.stats()).toMatchObject({ wasted: 1, pending: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset aborts everything pending", () => {
    const store = makeStore();
    store.launch("tc1", "omp.read", { path: "a.ts" }, (signal) => {
      expect(signal.aborted).toBe(false);
      return new Promise(() => {});
    }, undefined, {}, "b1");
    store.reset();
    expect(store.stats().pending).toBe(0);
  });
});
