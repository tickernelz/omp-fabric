import { describe, expect, it } from "vitest";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const options = { timeoutMs: 10_000, memoryLimitBytes: 64 * 1024 * 1024 };

const PROGRAM = `
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
const failure = async (run: () => unknown) => {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error.name;
  }
};
const encoder = new TextEncoder();
const text = "h\\u00e9\\u20ac\\u{1f600}";
const destination = new Uint8Array(5);
const url = new URL("../x?a=1&b=2#h", "https://user:pw@example.com:8443/p/q/r");
const resolved = [url.href, url.origin, url.host, url.pathname, url.search, url.hash];
url.searchParams.append("c", "3 4");
url.searchParams.delete("a");
const afterParams = url.href;
url.search = "?z=9";
const key = await crypto.subtle.importKey("raw", encoder.encode("Jefe"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const data = encoder.encode("what do ya want for nothing?");
const signature = await crypto.subtle.sign("HMAC", key, data);
const random = crypto.getRandomValues(new Uint32Array(8));
return {
  encoded: Array.from(encoder.encode(text)),
  decoded: new TextDecoder().decode(encoder.encode(text)),
  replaced: new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62])),
  fatal: await failure(() => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]))),
  encodeInto: [encoder.encodeInto("a\\u20acb", destination), Array.from(destination)],
  base64: [btoa("hello"), atob("aGVsbG8=")],
  btoaRange: await failure(() => btoa("\\u20ac")),
  resolved,
  afterParams,
  searchFollowsUrl: url.searchParams.get("z"),
  invalidUrl: await failure(() => new URL("not a url")),
  params: new URLSearchParams({ q: "a b&c", x: "\\u00e9" }).toString(),
  sha1: hex(await crypto.subtle.digest("SHA-1", encoder.encode("abc"))),
  sha256: hex(await crypto.subtle.digest({ name: "SHA-256" }, encoder.encode("abc"))),
  sha512: hex(await crypto.subtle.digest("SHA-512", encoder.encode("abc").buffer)).slice(0, 32),
  hmac: hex(signature),
  verified: [await crypto.subtle.verify("HMAC", key, signature, data), await crypto.subtle.verify("HMAC", key, signature, encoder.encode("x"))],
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()),
  randomFilled: random.some((value) => value !== 0),
  quota: await failure(() => crypto.getRandomValues(new Uint8Array(65_537))),
  unsupportedDigest: await failure(() => crypto.subtle.digest("MD5" as "SHA-1", data)),
  unsupportedSubtle: await failure(() => (crypto.subtle as any).encrypt({ name: "AES-GCM" }, key, data)),
  bridgeHidden: typeof (globalThis as any).__fabricSync,
};
`;

const EXPECTED = {
  encoded: [104, 195, 169, 226, 130, 172, 240, 159, 152, 128],
  decoded: "h\u00e9\u20ac\u{1f600}",
  replaced: "a\ufffdb",
  fatal: "TypeError",
  encodeInto: [{ read: 3, written: 5 }, [97, 226, 130, 172, 98]],
  base64: ["aGVsbG8=", "hello"],
  btoaRange: "InvalidCharacterError",
  resolved: [
    "https://user:pw@example.com:8443/p/x?a=1&b=2#h",
    "https://example.com:8443",
    "example.com:8443",
    "/p/x",
    "?a=1&b=2",
    "#h",
  ],
  afterParams: "https://user:pw@example.com:8443/p/x?b=2&c=3+4#h",
  searchFollowsUrl: "9",
  invalidUrl: "TypeError",
  params: "q=a+b%26c&x=%C3%A9",
  sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  sha512: "ddaf35a193617abacc417349ae204131",
  hmac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  verified: [true, false],
  uuid: true,
  randomFilled: true,
  quota: "QuotaExceededError",
  unsupportedDigest: "NotSupportedError",
  unsupportedSubtle: "NotSupportedError",
  bridgeHidden: "undefined",
};

describe("guest web globals", () => {
  it("type-checks a program that uses the web globals", () => {
    expect(typeCheckFabricCode(PROGRAM, guestTypeDeclarations(true)).errors).toEqual([]);
  });

  it.each([
    ["QuickJS", () => new QuickJsRuntime()],
    ["Node process", () => new NodeProcessRuntime()],
  ])("encodes, parses and hashes with standard results in %s", async (_name, runtime) => {
    const result = await runtime().execute(PROGRAM, async () => undefined, options);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(EXPECTED);
  });
});
