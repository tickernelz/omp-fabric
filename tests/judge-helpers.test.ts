import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const options = {
  timeoutMs: 10_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

describe("judge helper runtime integration", () => {
  it("evaluates judge.bool successfully and supports fallback", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "judgment.ask") {
        const state = (args as { state: Record<string, unknown> }).state;
        if (state.fail) {
          return { ok: false, reason: "failed", detail: "network error" };
        }
        if (state.throw) {
          throw new Error("transport failure");
        }
        return {
          ok: true,
          backend: "test/judge",
          answers: { q: { type: "bool", bool: 0.88 } },
        };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const p1 = await judge.bool({ test: 1 }, "Is valid?");
const p2 = await judge.bool({ fail: true }, "Is valid?");
const p3 = await judge.bool({ fail: true }, "Is valid?", { fallback: 0.5 });
const p4 = await judge.bool({ throw: true }, "Is valid?", { fallback: 0.1 });
return { p1, p2, p3, p4 };
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ p1: 0.88, p2: undefined, p3: 0.5, p4: 0.1 });
    expect(hostCall).toHaveBeenCalledTimes(4);
  });

  it("evaluates judge.choice with array and criteria object, handling duplicates and fallbacks", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "judgment.ask") {
        const state = (args as { state: unknown }).state;
        if (state === "throw") {
          throw new Error("transport disconnect");
        }
        return {
          ok: true,
          backend: "test/judge",
          answers: { q: { type: "choice", choice: "database", confidence: 0.9 } },
        };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const c1 = await judge.choice("error text", ["ui", "database", "network"], "classify");
const c2 = await judge.choice("error text", { database: "DB issue", ui: "Visual bug" }, "classify");
const c3 = await judge.choice("throw", ["a", "b"], "classify", { fallback: "fallback_val" });
let dupError = "";
try {
  await judge.choice("state", ["same", "same"], "prompt");
} catch (e) {
  dupError = e.message;
}
return { c1, c2, c3, dupError };
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      c1: "database",
      c2: "database",
      c3: "fallback_val",
      dupError: "judge.choice requires at least 2 unique options",
    });
    const call1 = hostCall.mock.calls[0]?.[1] as { questions: Record<string, { criteria: Record<string, unknown> }> };
    expect(Object.keys(call1.questions.q!.criteria)).toEqual(["ui", "database", "network"]);
    const call2 = hostCall.mock.calls[1]?.[1] as { questions: Record<string, { criteria: Record<string, unknown> }> };
    expect(call2.questions.q!.criteria).toEqual({ database: "DB issue", ui: "Visual bug" });
  });

  it("evaluates judge.score and handles fallbacks", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "judgment.ask") {
        const state = (args as { state: unknown }).state;
        if (state === "fail") {
          return { ok: false, reason: "refused", detail: "rate limited" };
        }
        if (state === "throw") {
          throw new Error("pipe broken");
        }
        return {
          ok: true,
          backend: "test/judge",
          answers: { q: { type: "score", score: 2 } },
        };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const s1 = await judge.score("mild bug", ["low", "medium", "critical"], "severity");
const s2 = await judge.score("fail", ["low", "high"], "severity", { fallback: 0 });
const s3 = await judge.score("throw", ["low", "high"], "severity", { fallback: 1 });
return { s1, s2, s3 };
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ s1: 2, s2: 0, s3: 1 });
  });

  it("handles positional judge.ask even when state has state and questions properties", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "judgment.ask") {
        return {
          ok: true,
          backend: "test/judge",
          answers: { ans: { type: "bool", bool: 1 } },
        };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const myState = { state: "in_progress", questions: 5 };
const myQuestions = { ans: { type: "bool", instructions: "Is done?" } };
const res = await judge.ask(myState, myQuestions);
return res;
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect((result.value as { ok: boolean }).ok).toBe(true);
    const passedArgs = hostCall.mock.calls[0]?.[1] as { state: unknown; questions: unknown };
    expect(passedArgs.state).toEqual({ state: "in_progress", questions: 5 });
    expect(passedArgs.questions).toEqual({ ans: { type: "bool", instructions: "Is done?" } });
  });

  it("evaluates judge.filter with chunking, threshold filtering, and oversized item truncation", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "judgment.ask") {
        const state = (args as { state: { items: string[] } }).state;
        const answers: Record<string, { type: "bool"; bool: number }> = {};
        state.items.forEach((item, idx) => {
          expect(typeof item === "string" ? item.length : 0).toBeLessThanOrEqual(40100);
          answers["item_" + idx] = {
            type: "bool",
            bool: String(item).startsWith("err") ? 0.95 : 0.1,
          };
        });
        return { ok: true, backend: "test/judge", answers };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const giantItem = "err_giant_" + "x".repeat(50000);
const items = [giantItem, ...Array.from({ length: 29 }, (_, i) => i % 2 === 0 ? "err_" + i : "ok_" + i)];
const filtered = await judge.filter(items, "is error", { maxItems: 20 });
return { count: filtered.length, giantPreservedLength: filtered[0].length };
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    const val = result.value as { count: number; giantPreservedLength: number };
    expect(val.count).toBe(16);
    expect(val.giantPreservedLength).toBe(50010);
    expect(hostCall).toHaveBeenCalledTimes(2);
  });

  it("handles judge.filter fail-open behavior on network failure", async () => {
    const hostCall = vi.fn(async (ref: string) => {
      if (ref === "judgment.ask") {
        return { ok: false, reason: "timeout", detail: "host timeout" };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const items = ["a", "b", "c"];
const rKeep = await judge.filter(items, "is error", { onFail: "keep-all" });
const rEmpty = await judge.filter(items, "is error", { onFail: "empty" });
return { rKeep, rEmpty };
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      rKeep: ["a", "b", "c"],
      rEmpty: [],
    });
  });

  it("evaluates judge.classify across chunks with fail-open fallback and error modes", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "judgment.ask") {
        const state = (args as { state: { items: string[] } }).state;
        if (state.items.includes("fail_all")) {
          return { ok: false, reason: "failed", detail: "provider down" };
        }
        const answers: Record<string, { type: "choice"; choice: string; confidence: number }> = {};
        state.items.forEach((item, idx) => {
          answers["item_" + idx] = {
            type: "choice",
            choice: item.includes("db") ? "database" : "ui",
            confidence: 0.9,
          };
        });
        return { ok: true, backend: "test/judge", answers };
      }
      return undefined;
    });

    const runtime = new QuickJsRuntime();
    const result = await runtime.execute(
      `
const items = ["db error 1", "ui glitch 1", "db error 2", "ui glitch 2"];
const classified = await judge.classify(items, ["database", "ui"], "category", { maxItems: 2 });
const failFallback = await judge.classify(["fail_all"], ["database", "ui"], "category", {
  onFail: "keep-all",
  fallbackCategory: "unknown",
});
const failEmpty = await judge.classify(["fail_all"], ["database", "ui"], "category", {
  onFail: "empty",
});
return { classified, failFallback, failEmpty };
`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    const val = result.value as {
      classified: Array<{ item: string; category: string; confidence: number }>;
      failFallback: Array<{ item: string; category: string }>;
      failEmpty: unknown[];
    };
    expect(val.classified.length).toBe(4);
    expect(val.classified[0]).toEqual({ item: "db error 1", category: "database", confidence: 0.9 });
    expect(val.failFallback).toEqual([{ item: "fail_all", category: "unknown", confidence: undefined }]);
    expect(val.failEmpty).toEqual([]);
    expect(hostCall).toHaveBeenCalledTimes(4);
  });
});
