import { describe, expect, it } from "vitest";
import { typeErrorRecoveryHint } from "../src/type-error-guidance.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const hintFor = (code: string): string | undefined => {
  const result = typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS);
  expect(result.errors.length).toBeGreaterThan(0);
  return typeErrorRecoveryHint(code, result.errors);
};

describe("typeErrorRecoveryHint against real type-checker output", () => {
  it("routes settle on omp.edit to omp.bash", () => {
    expect(hintFor(
      'return omp.edit({ path: "x", oldText: "a", newText: "b", settle: true });',
    )).toContain("belongs to `omp.bash`");
  });

  it("points nested strings at the fabric_exec envelope", () => {
    expect(hintFor(
      'return omp.bash({ command: "echo hi", payloads: { payload: "x" } });',
    )).toContain("outer `fabric_exec` arguments");
  });

  it("routes context on omp.read to omp.grep", () => {
    expect(hintFor(
      'return omp.read({ path: "a", context: 3 });',
    )).toContain("belongs to `omp.grep`");
  });
});
