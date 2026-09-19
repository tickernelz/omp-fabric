import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const declarations = guestTypeDeclarations(true);

describe("judgment guest declarations", () => {
  it("lets guest code ask every question kind and read the narrowed answers", () => {
    const checked = typeCheckFabricCode(
      `
const verdict = await judgment.ask({
  state: { turn: "delete the production database" },
  questions: {
    destructive: { type: "bool", instructions: "irreversible?", criteria: { true: "yes", false: "no" } },
    severity: { type: "score", instructions: "how bad?", criteria: ["harmless", "recoverable", "fatal"] },
    handler: { type: "choice", instructions: "who?", criteria: { scout: "investigate", task: null } },
  },
});
if (!verdict.ok) return verdict.reason;
const answer = verdict.answers.destructive;
if (answer.type !== "bool") return "unexpected";
const probability: number = answer.bool;
const counters = await judgment.stats();
return { probability, backend: verdict.backend, requests: counters.requests };
`,
      declarations,
    );

    expect(checked.errors).toEqual([]);
  });

  it("does not answer to another spelling", () => {
    const checked = typeCheckFabricCode(
      'await judgement.ask({ state: "x", questions: { a: { type: "bool", instructions: "yes?" } } }); return "never";',
      declarations,
    );

    expect(checked.errors.some((error) => error.message.startsWith("Cannot find name 'judgement'"))).toBe(
      true,
    );
  });

  it("reaches the provider from a running guest program", async () => {
    const hostCall = vi.fn(async (_ref: string, _args: Record<string, unknown>) => ({
      ok: true,
      backend: "test/fake-1",
      answers: { destructive: { type: "bool", bool: 0.9 } },
    }));

    const result = await new QuickJsRuntime().execute(
      'const verdict = await judgment.ask({ state: "x", questions: { destructive: { type: "bool", instructions: "irreversible?" } } }); return verdict;',
      hostCall,
      { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 },
    );

    expect(result.error).toBeUndefined();
    expect(hostCall).toHaveBeenCalledTimes(1);
    expect(hostCall.mock.calls[0]?.[0]).toBe("judgment.ask");
    expect(result.value).toEqual({
      ok: true,
      backend: "test/fake-1",
      answers: { destructive: { type: "bool", bool: 0.9 } },
    });
  });
});
