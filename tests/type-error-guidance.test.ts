import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { typeErrorRecoveryHint } from "../src/type-error-guidance.js";
import {
  CORE_TOOL_NAMES,
  CORE_TOOL_PROPERTIES,
} from "../src/runtime/core-tool-properties.js";

const typeError = (message: string, line = 1, column = 1) => ({ line, column, message });

describe("typeErrorRecoveryHint", () => {
  it("treats omp.bash cwd as a supported option since #71", () => {
    const checked = typeCheckFabricCode('await omp.bash({ command: "ls", cwd: "/tmp" });', GUEST_TYPE_DECLARATIONS);
    expect(checked.errors).toHaveLength(0);
  });

  it("guides unsupported omp.bash stdin toward a file input", () => {
    expect(typeErrorRecoveryHint(
      'await omp.bash({ command: "gh issue create --body-file -", stdin: omp.body });',
      [{
        line: 1,
        column: 61,
        message:
          "Object literal may only specify known properties, and 'stdin' does not exist in type 'OmpCommandArgument & OmpBashOptions'.",
      }],
    )).toContain("omp.write(path, content)");
  });

  it("recognizes the real TypeScript diagnostics for unsupported bash options", () => {
    const cases = [
      {
        code: 'await omp.bash({ command: "gh issue create --body-file -", stdin: omp.body });',
        expected: "omp.write(path, content)",
      },
    ];

    for (const { code, expected } of cases) {
      const checked = typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS);
      expect(checked.errors.length).toBeGreaterThan(0);
      expect(typeErrorRecoveryHint(code, checked.errors)).toContain(expected);
    }
  });

  it("guides malformed edit payloads toward named payloads", () => {
    expect(typeErrorRecoveryHint(
      'await omp.edit({ path: "x", oldText: "a", newText: "broken });',
      [{ line: 1, column: 55, message: "Unterminated string literal." }],
    )).toContain("top-level `payloads`");
  });

  it("routes unknown properties to the core tool that owns them", () => {
    expect(typeErrorRecoveryHint(
      'return omp.edit({ path: "x", oldText: "a", newText: "b", settle: true });',
      [typeError(
        "Object literal may only specify known properties, and 'settle' does not exist in type 'OmpEditArgument'.",
        1,
        58,
      )],
    )).toContain("belongs to `omp.bash`");
  });

  it("resolves two-arg option bags from the type alias", () => {
    expect(typeErrorRecoveryHint(
      'return omp.read("index.ts", { settle: true });',
      [typeError(
        "Object literal may only specify known properties, and 'settle' does not exist in type 'OmpReadOptions'.",
        1,
        26,
      )],
    )).toContain("belongs to `omp.bash`");
  });

  it("falls back to the enclosing omp call for shared-bag type names", () => {
    expect(typeErrorRecoveryHint(
      'return omp.write({ path: "x", content: "a", timeout: 5 });',
      [typeError(
        "Object literal may only specify known properties, and 'timeout' does not exist in type 'OmpContentArgument'.",
        1,
        43,
      )],
    )).toContain("belongs to `omp.bash`");
  });

  it("points nested strings at the outer fabric_exec arguments", () => {
    expect(typeErrorRecoveryHint(
      'return omp.bash({ command: "echo", payloads: { payload: "x" } });',
      [typeError(
        "Object literal may only specify known properties, and 'strings' does not exist in type 'OmpCommandArgument & OmpBashOptions'.",
        1,
        35,
      )],
    )).toContain("outer `fabric_exec` arguments");
  });

  it("generalizes the cross-tool hint across the remaining tools", () => {
    expect(typeErrorRecoveryHint(
      'return omp.read({ path: "a", context: 3 });',
      [typeError(
        "Object literal may only specify known properties, and 'context' does not exist in type 'OmpReadArgument'.",
        1,
        28,
      )],
    )).toContain("belongs to `omp.grep`");
  });

  it("stays silent when the property is valid for the called tool", () => {
    expect(typeErrorRecoveryHint(
      'return omp.read({ path: "a", limit: 5 });',
      [typeError(
        "Object literal may only specify known properties, and 'limit' does not exist in type 'OmpReadArgument'.",
        1,
        28,
      )],
    )).toBeUndefined();
  });

  it("stays silent for properties outside every core tool schema", () => {
    expect(typeErrorRecoveryHint(
      'return omp.edit({ pth: "x", oldText: "a", newText: "b" });',
      [typeError(
        "Object literal may only specify known properties, and 'pth' does not exist in type 'OmpEditArgument'.",
        1,
        22,
      )],
    )).toBeUndefined();
  });

  it("derives the property registry from the guest type declarations", () => {
    expect(CORE_TOOL_NAMES).toEqual([
      "read", "bash", "edit", "write", "grep", "find", "ls",
    ]);
    expect(CORE_TOOL_PROPERTIES.get("settle")).toEqual(["bash"]);
    expect(CORE_TOOL_PROPERTIES.get("timeout")).toEqual(["bash"]);
    expect(CORE_TOOL_PROPERTIES.get("edits")).toEqual(["edit"]);
    expect(CORE_TOOL_PROPERTIES.get("context")).toEqual(["grep"]);
    expect(CORE_TOOL_PROPERTIES.get("content")).toEqual(["write"]);
    expect(CORE_TOOL_PROPERTIES.get("path") ?? []).toEqual(
      expect.arrayContaining(["read", "edit", "write", "grep", "find", "ls"]),
    );
  });

  it("calls out Promise.all tuple arity mismatches", () => {
    expect(typeErrorRecoveryHint(
      "const [first, second, third] = await Promise.all([omp.read('a'), omp.read('b')]);",
      [{ line: 1, column: 23, message: "Tuple type '[string, string]' of length '2' has no element at index '2'." }],
    )).toContain("one binding per promise");
  });

  it("distinguishes literal payload interpolation from executor variables", () => {
    expect(typeErrorRecoveryHint(
      'return omp.edit({ path: "x", oldText: `<script src="${CONTEXT_PATH}/x">`, newText: `<script src="${CONTEXT_PATH}/y">` });',
      [{ line: 1, column: 57, message: "Cannot find name 'CONTEXT_PATH'." }],
    )).toContain("being evaluated by the Fabric TypeScript program");
  });

  it("stays absent for semantic errors and unrelated code", () => {
    expect(typeErrorRecoveryHint(
      'await omp.edit({ path: "x", all: true });',
      [{ line: 1, column: 15, message: "Property oldText is missing." }],
    )).toBeUndefined();
    expect(typeErrorRecoveryHint(
      "return missingValue;",
      [{ line: 1, column: 8, message: "':' expected." }],
    )).toBeUndefined();
    expect(typeErrorRecoveryHint(
      'await omp.read({ path: "x", cwd: "y" });',
      [{
        line: 1,
        column: 28,
        message:
          "Object literal may only specify known properties, and 'cwd' does not exist in type 'OmpReadArgument'.",
      }],
    )).toContain("belongs to `omp.bash`");
  });

  it("guides unquoted omp.read paths toward quoted strings", () => {
    expect(typeErrorRecoveryHint(
      "return await omp.read(/tmp/x);",
      [{ line: 1, column: 20, message: "Invalid character." }],
    )).toContain("quote filesystem paths");
  });
});
