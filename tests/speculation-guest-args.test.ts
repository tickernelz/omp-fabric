import { describe, expect, it } from "vitest";
import { GUEST_SETUP } from "../src/runtime/quickjs-runtime.js";
import { guestOmpArgs } from "../src/speculation/guest-args.js";

const bridgeSource = (): string => {
  const start = GUEST_SETUP.indexOf("const __ompStringFields");
  const end = GUEST_SETUP.indexOf("const __ompEnvelopeTools");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return GUEST_SETUP.slice(start, end);
};

const bridgeNormalize = new Function(
  `${bridgeSource()}
   return (name, rest) => {
     const args = rest.length <= 1
       ? (rest.length === 1 ? rest[0] : undefined)
       : __positionalToArgs(name, rest);
     return __normalizeOmpArgs(name, args === undefined ? {} : args);
   };`,
)() as (name: string, rest: readonly unknown[]) => unknown;

const cases: { name: string; rest: unknown[] }[] = [
  { name: "read", rest: ["/abs/path.ts"] },
  { name: "read", rest: [{ path: "/abs/path.ts" }] },
  { name: "read", rest: ["/abs/path.ts", { limit: 120 }] },
  { name: "read", rest: [{ file: "/abs/path.ts", start: 3 }] },
  { name: "read", rest: [{ path: "a.ts", offset: "12", limit: "40" }] },
  { name: "read", rest: [{ path: "a.ts", offset: null }] },
  { name: "read", rest: [] },
  { name: "ls", rest: ["src"] },
  { name: "ls", rest: [{ directory: "src", max: 20 }] },
  { name: "grep", rest: ["TODO", "src"] },
  { name: "grep", rest: ["TODO", "src", 20] },
  { name: "grep", rest: ["TODO", { ignoreCase: true }] },
  { name: "grep", rest: [{ query: "TODO", ctx: "2" }] },
  { name: "find", rest: ["*.ts", "src"] },
  { name: "find", rest: [{ glob: "*.ts", max: "5" }] },
  { name: "bash", rest: ["ls -la"] },
  { name: "bash", rest: [{ cmd: "ls", timeoutMs: 4000 }] },
  { name: "bash", rest: [{ command: "ls", settle: true }] },
  { name: "write", rest: ["a.ts", "body"] },
  { name: "edit", rest: ["a.ts", "old", "new"] },
  { name: "edit", rest: [{ path: "a.ts", edits: [{ old: "a", new: "b" }] }] },
];

describe("guestOmpArgs mirrors the guest bridge", () => {
  it.each(cases)("normalizes omp.$name($rest) exactly like GUEST_SETUP", ({ name, rest }) => {
    expect(guestOmpArgs(name, rest)).toEqual(bridgeNormalize(name, rest));
  });

  it("returns undefined when the bridge would send a non-object", () => {
    expect(guestOmpArgs("agent", ["prompt"])).toBeUndefined();
    expect(bridgeNormalize("agent", ["prompt"])).toBe("prompt");
  });
});
