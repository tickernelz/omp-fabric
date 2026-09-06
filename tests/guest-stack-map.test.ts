import { describe, expect, it } from "vitest";
import {
  createGuestStackMap,
  remapGuestErrorText,
  type GuestStackMap,
} from "../src/runtime/guest-stack-map.js";
import { transpileFabricCodeWithSourceMap } from "../src/runtime/type-checker.js";

const mapForUserCode = (code: string): { emitted: string; stackMap: GuestStackMap } => {
  const transpiled = transpileFabricCodeWithSourceMap(code);
  const stackMap = createGuestStackMap(transpiled.sourceMap);
  if (!stackMap) throw new Error("expected a stack map");
  return { emitted: transpiled.code, stackMap };
};

const emittedLineOf = (emitted: string, needle: string): number => {
  const index = emitted.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`emitted code is missing ${needle}:\n${emitted}`);
  return index + 1;
};

describe("createGuestStackMap", () => {
  it("returns undefined for missing or malformed maps", () => {
    expect(createGuestStackMap(undefined)).toBeUndefined();
    expect(createGuestStackMap("not json")).toBeUndefined();
    expect(createGuestStackMap("{}")).toBeUndefined();
  });
});

describe("remapGuestErrorText", () => {
  it("maps emitted frames back to user code lines", () => {
    const code = [
      "const before = 1;",
      "print(before);",
      'throw new Error("boom");',
    ].join("\n");
    const { emitted, stackMap } = mapForUserCode(code);
    const line = emittedLineOf(emitted, 'throw new Error("boom")');
    const column = (emitted.split("\n")[line - 1] as string).indexOf("throw") + 1;
    const stack = `Error: boom\n    at __ompFabricMain (omp-fabric-guest.js:${line}:${column})`;
    expect(remapGuestErrorText(stack, stackMap)).toContain(
      "at __ompFabricMain (guest code:3:",
    );
  });

  it("passes JSON.parse style errors through with only the guest frame remapped", () => {
    const code = ['const payload = "    },";', "JSON.parse(payload);"].join("\n");
    const { emitted, stackMap } = mapForUserCode(code);
    const line = emittedLineOf(emitted, "JSON.parse");
    const stack = [
      "SyntaxError: unexpected token: '}'",
      "    at <input>:1:5",
      "    at parse (native)",
      `    at __ompFabricMain (omp-fabric-guest.js:${line}:1)`,
    ].join("\n");
    const remapped = remapGuestErrorText(stack, stackMap);
    expect(remapped).toContain("    at <input>:1:5");
    expect(remapped).toContain("    at parse (native)");
    expect(remapped).toContain("guest code:2:");
    expect(remapped).not.toContain("omp-fabric-guest.js");
  });

  it("returns text unchanged when no stack map is available", () => {
    const text = "    at __ompFabricMain (omp-fabric-guest.js:11:29)";
    expect(remapGuestErrorText(text, undefined)).toBe(text);
  });

  it("relabels frames on runtime-appended driver lines", () => {
    const { emitted, stackMap } = mapForUserCode("return 1;");
    const guestLines = emitted.split("\n").length;
    const text = `    at <eval> (omp-fabric-guest.js:${guestLines + 1}:29)`;
    expect(remapGuestErrorText(text, stackMap, guestLines)).toBe("    at <eval> (fabric driver)");
  });

  it("keeps unmapped frames intact when no guest line count is given", () => {
    const { stackMap } = mapForUserCode("return 1;");
    const text = "    at f (omp-fabric-guest.js:999:1)";
    expect(remapGuestErrorText(text, stackMap)).toBe(text);
  });

  it("leaves non-guest text untouched", () => {
    const { stackMap } = mapForUserCode("return 1;");
    const text = "TypeError: nope\n    at omp.read (native)\n    at <input>:1:1";
    expect(remapGuestErrorText(text, stackMap)).toBe(text);
  });
});
