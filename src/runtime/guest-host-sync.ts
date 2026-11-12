import * as nodeCrypto from "node:crypto";
import { runInThisContext } from "node:vm";

type FabricSyncCall = (operation: string, argsJson: string) => string;

export const FABRIC_SYNC_FACTORY_SOURCE = String.raw`((nodeCrypto) => {
  const digestNames = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
  const urlProperties = ["href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];
  const failure = (name, message) => Object.assign(new Error(message), { name });
  const canonicalHash = (name) => {
    const canonical = String(name ?? "").toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(digestNames, canonical)) {
      throw failure("NotSupportedError", "Unrecognized digest algorithm: " + name + ". fabric_exec supports SHA-1, SHA-256, SHA-384 and SHA-512.");
    }
    return canonical;
  };
  const bytes = (hex) => Buffer.from(typeof hex === "string" ? hex : "", "hex");
  const hmac = (hash, key, data) =>
    nodeCrypto.createHmac(digestNames[canonicalHash(hash)], bytes(key)).update(bytes(data)).digest();
  const urlParts = (url) => {
    const parts = { origin: url.origin };
    for (const property of urlProperties) parts[property] = url[property];
    return parts;
  };
  const operations = {
    random: ({ length }) => nodeCrypto.randomBytes(Math.min(Math.max(Math.trunc(Number(length)) || 0, 0), 65536)).toString("hex"),
    uuid: () => nodeCrypto.randomUUID(),
    hashName: ({ algorithm }) => canonicalHash(algorithm),
    digest: ({ algorithm, data }) =>
      nodeCrypto.createHash(digestNames[canonicalHash(algorithm)]).update(bytes(data)).digest("hex"),
    hmac: ({ hash, key, data }) => hmac(hash, key, data).toString("hex"),
    hmacVerify: ({ hash, key, data, signature }) => {
      const expected = hmac(hash, key, data);
      const actual = bytes(signature);
      return expected.length === actual.length && nodeCrypto.timingSafeEqual(expected, actual);
    },
    utf8Encode: ({ text }) => Buffer.from(String(text), "utf8").toString("hex"),
    utf8Decode: ({ data, fatal, ignoreBOM }) =>
      new TextDecoder("utf-8", { fatal: fatal === true, ignoreBOM: ignoreBOM === true }).decode(bytes(data)),
    atob: ({ data }) => atob(data),
    btoa: ({ data }) => btoa(data),
    url: ({ input, base }) => urlParts(base === undefined ? new URL(input) : new URL(input, base)),
    urlSet: ({ href, property, value }) => {
      if (urlProperties.indexOf(property) < 0) throw new TypeError("URL has no settable property " + property);
      const url = new URL(href);
      url[property] = value;
      return urlParts(url);
    },
    searchParse: ({ init }) => Array.from(new URLSearchParams(init)),
    searchSerialize: ({ pairs }) => new URLSearchParams(pairs).toString(),
  };
  return (operation, argsJson) => {
    try {
      if (!Object.prototype.hasOwnProperty.call(operations, operation)) {
        throw new TypeError("Unknown fabric sync operation " + operation);
      }
      return JSON.stringify({ ok: true, value: operations[operation](JSON.parse(argsJson)) });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        name: error && typeof error.name === "string" ? error.name : "Error",
        message: error && typeof error.message === "string" ? error.message : String(error),
      });
    }
  };
})`;

let fabricSync: FabricSyncCall | undefined;

export const fabricSyncCall: FabricSyncCall = (operation, argsJson) => {
  fabricSync ??= (runInThisContext(FABRIC_SYNC_FACTORY_SOURCE) as (crypto: typeof nodeCrypto) => FabricSyncCall)(nodeCrypto);
  return fabricSync(operation, argsJson);
};
