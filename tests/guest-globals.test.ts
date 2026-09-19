import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const declaredApis = [...GUEST_TYPE_DECLARATIONS.matchAll(/declare const (\w+): \w*Api;/gu)].map(
  (match) => match[1]!,
);

describe("guest globals", () => {
  it("declares at least the providers this build ships", () => {
    expect(declaredApis).toEqual(expect.arrayContaining(["judgment", "codemap", "compact", "memory"]));
  });

  it("defines every declared API global in a running guest program", async () => {
    const result = await new QuickJsRuntime().execute(
      `return { ${declaredApis.map((name) => `${name}: typeof ${name}`).join(", ")} };`,
      async () => undefined,
      { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 },
    );

    expect(result.error).toBeUndefined();
    const kinds = result.value as Record<string, string>;
    const missing = declaredApis.filter((name) => kinds[name] === "undefined");
    expect(missing).toEqual([]);
  });
});
