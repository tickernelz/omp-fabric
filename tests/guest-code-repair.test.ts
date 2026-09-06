import { describe, expect, it } from "vitest";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";
import { repairFabricGuestCode } from "../src/runtime/guest-code-repair.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

describe("repairFabricGuestCode", () => {
  it("returns the same string when nothing needs quoting", () => {
    const code = 'return await omp.read("/tmp/x");';
    expect(repairFabricGuestCode(code)).toBe(code);
  });

  it("quotes an unquoted absolute path on omp.read", () => {
    expect(repairFabricGuestCode("return await omp.read(/tmp/x);")).toBe(
      'return await omp.read("/tmp/x");',
    );
  });

  it("keeps a following options argument", () => {
    expect(repairFabricGuestCode("return await omp.read(/tmp/x, { limit: 1 });")).toBe(
      'return await omp.read("/tmp/x", { limit: 1 });',
    );
  });

  it("quotes object path values", () => {
    expect(repairFabricGuestCode("return await omp.read({ path: /Users/foo/bar.ts });")).toBe(
      'return await omp.read({ path: "/Users/foo/bar.ts" });',
    );
  });

  it("quotes URLs including query strings that look like extra paths", () => {
    expect(
      repairFabricGuestCode("return await omp.read(https://example.com/foo.md5?q=/a/b/c/d);"),
    ).toBe('return await omp.read("https://example.com/foo.md5?q=/a/b/c/d");');
  });

  it("quotes macOS cache paths with md5 query fragments", () => {
    const input =
      "return await omp.read(/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g);";
    expect(repairFabricGuestCode(input)).toBe(
      'return await omp.read("/var/folders/xx/T/cache.md5?q=/a/b/c/d/e/f/g");',
    );
  });

  it("does not quote grep regex literals", () => {
    const code = "return await omp.grep(/TODO/g, 'src');";
    expect(repairFabricGuestCode(code)).toBe(code);
  });

  it("quotes grep object path values", () => {
    expect(repairFabricGuestCode('return await omp.grep({ pattern: "TODO", path: /src });')).toBe(
      'return await omp.grep({ pattern: "TODO", path: "/src" });',
    );
  });

  it("does not rewrite omp.read inside an already-quoted payload", () => {
    const code = "return await omp.write('/a.ts', 'omp.read(/tmp/x)');";
    expect(repairFabricGuestCode(code)).toBe(code);
  });

  it("repairs omp.read inside template expressions", () => {
    expect(repairFabricGuestCode("return `x ${await omp.read(/tmp/x)}`;")).toBe(
      'return `x ${await omp.read("/tmp/x")}`;',
    );
  });

  it("normalizes unicode quotes around a path", () => {
    expect(repairFabricGuestCode("return await omp.read(\u201c/tmp/x\u201d);")).toBe(
      'return await omp.read("/tmp/x");',
    );
  });

  it("quotes relative and home paths", () => {
    expect(repairFabricGuestCode("return await omp.read(./src/index.ts);")).toBe(
      'return await omp.read("./src/index.ts");',
    );
    expect(repairFabricGuestCode("return await omp.ls(../lib);")).toBe(
      'return await omp.ls("../lib");',
    );
    expect(repairFabricGuestCode("return await omp.read(~/.bashrc);")).toBe(
      'return await omp.read("~/.bashrc");',
    );
  });

  it("quotes Windows drive paths", () => {
    expect(repairFabricGuestCode("return await omp.read(C:/Users/foo/bar.ts);")).toBe(
      'return await omp.read("C:/Users/foo/bar.ts");',
    );
  });

  it("is idempotent", () => {
    const once = repairFabricGuestCode("return await omp.read(/tmp/x);");
    expect(repairFabricGuestCode(once)).toBe(once);
  });

  it("makes previously unparseable omp.read typecheck", () => {
    const original = "return await omp.read(/tmp/x);";
    expect(typeCheckFabricCode(original, GUEST_TYPE_DECLARATIONS).errors.length).toBeGreaterThan(0);
    expect(typeCheckFabricCode(repairFabricGuestCode(original), GUEST_TYPE_DECLARATIONS).errors).toEqual([]);
  });
});

describe("prepareFabricExecArguments path repair", () => {
  it("quotes unquoted omp.read paths on the envelope code field", () => {
    expect(prepareFabricExecArguments({ code: "return await omp.read(/tmp/x);" })).toEqual({
      code: 'return await omp.read("/tmp/x");',
    });
  });
});
