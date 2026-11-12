export const GUEST_WEB_GLOBALS_SOURCE = String.raw`(__fabricSync) => {
  const __namedError = (ErrorType, name, message) => {
    const error = new ErrorType(message);
    if (error.name !== name) error.name = name;
    return error;
  };
  const __syncCall = (operation, args) => {
    const reply = JSON.parse(__fabricSync(operation, JSON.stringify(args)));
    if (reply.ok) return reply.value;
    const ErrorType = reply.name === "TypeError" ? TypeError : reply.name === "RangeError" ? RangeError : Error;
    throw __namedError(ErrorType, reply.name, reply.message);
  };
  const __hexByte = Array.from({ length: 256 }, (_, value) => (value < 16 ? "0" : "") + value.toString(16));
  const __toHex = (bytes) => {
    const parts = new Array(bytes.length);
    for (let index = 0; index < bytes.length; index++) parts[index] = __hexByte[bytes[index]];
    return parts.join("");
  };
  const __fromHex = (hex) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(hex.substr(index * 2, 2), 16);
    return bytes;
  };
  const __bufferBytes = (input, label) => {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError(label + " must be an ArrayBuffer, a typed array or a DataView");
  };
  const __utf8Write = (destination, offset, code) => {
    if (code < 0x80) {
      destination[offset] = code;
    } else if (code < 0x800) {
      destination[offset] = 0xc0 | (code >> 6);
      destination[offset + 1] = 0x80 | (code & 63);
    } else if (code < 0x10000) {
      destination[offset] = 0xe0 | (code >> 12);
      destination[offset + 1] = 0x80 | ((code >> 6) & 63);
      destination[offset + 2] = 0x80 | (code & 63);
    } else {
      destination[offset] = 0xf0 | (code >> 18);
      destination[offset + 1] = 0x80 | ((code >> 12) & 63);
      destination[offset + 2] = 0x80 | ((code >> 6) & 63);
      destination[offset + 3] = 0x80 | (code & 63);
    }
  };
  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input = "") {
      return __fromHex(__syncCall("utf8Encode", { text: String(input) }));
    }
    encodeInto(source, destination) {
      let read = 0;
      let written = 0;
      for (const char of String(source)) {
        const point = char.codePointAt(0);
        const code = point >= 0xd800 && point <= 0xdfff ? 0xfffd : point;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (written + size > destination.length) break;
        __utf8Write(destination, written, code);
        written += size;
        read += char.length;
      }
      return { read, written };
    }
  }
  const __utf8Labels = ["utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"];
  const __decoderOptions = new WeakMap();
  class TextDecoder {
    constructor(label = "utf-8", options = {}) {
      if (__utf8Labels.indexOf(String(label).trim().toLowerCase()) < 0) {
        throw new RangeError("The encoding " + String(label) + " is not supported; fabric_exec TextDecoder decodes UTF-8 only");
      }
      __decoderOptions.set(this, {
        fatal: Boolean(options && options.fatal),
        ignoreBOM: Boolean(options && options.ignoreBOM),
      });
    }
    get encoding() { return "utf-8"; }
    get fatal() { return __decoderOptions.get(this).fatal; }
    get ignoreBOM() { return __decoderOptions.get(this).ignoreBOM; }
    decode(input, options) {
      if (options && options.stream) {
        throw new TypeError("TextDecoder stream mode is not available in fabric_exec; decode the complete buffer");
      }
      if (input === undefined) return "";
      const settings = __decoderOptions.get(this);
      return __syncCall("utf8Decode", {
        data: __toHex(__bufferBytes(input, "TextDecoder.decode input")),
        fatal: settings.fatal,
        ignoreBOM: settings.ignoreBOM,
      });
    }
  }
  const atob = (data) => __syncCall("atob", { data: String(data) });
  const btoa = (data) => __syncCall("btoa", { data: String(data) });
  const __searchState = new WeakMap();
  const __searchList = (params) => __searchState.get(params).list;
  const __searchChanged = (params) => {
    const owner = __searchState.get(params).url;
    if (owner) owner.search = params.toString();
  };
  class URLSearchParams {
    constructor(init = "") {
      let list = [];
      if (init instanceof URLSearchParams) {
        list = __searchList(init).map((pair) => [pair[0], pair[1]]);
      } else if (typeof init === "object" && init !== null) {
        if (typeof init[Symbol.iterator] === "function") {
          for (const pair of init) {
            const items = Array.from(pair);
            if (items.length !== 2) throw new TypeError("Each URLSearchParams init pair must have exactly two items");
            list.push([String(items[0]), String(items[1])]);
          }
        } else {
          for (const key of Object.keys(init)) list.push([key, String(init[key])]);
        }
      } else {
        list = __syncCall("searchParse", { init: String(init) });
      }
      __searchState.set(this, { list, url: undefined });
    }
    get size() { return __searchList(this).length; }
    append(name, value) {
      __searchList(this).push([String(name), String(value)]);
      __searchChanged(this);
    }
    delete(name, value) {
      const key = String(name);
      const state = __searchState.get(this);
      state.list = state.list.filter((pair) => pair[0] !== key || (value !== undefined && pair[1] !== String(value)));
      __searchChanged(this);
    }
    get(name) {
      const key = String(name);
      const pair = __searchList(this).find((entry) => entry[0] === key);
      return pair ? pair[1] : null;
    }
    getAll(name) {
      const key = String(name);
      return __searchList(this).filter((pair) => pair[0] === key).map((pair) => pair[1]);
    }
    has(name, value) {
      const key = String(name);
      return __searchList(this).some((pair) => pair[0] === key && (value === undefined || pair[1] === String(value)));
    }
    set(name, value) {
      const key = String(name);
      const state = __searchState.get(this);
      const index = state.list.findIndex((pair) => pair[0] === key);
      if (index < 0) {
        state.list.push([key, String(value)]);
      } else {
        state.list[index] = [key, String(value)];
        state.list = state.list.filter((pair, position) => position <= index || pair[0] !== key);
      }
      __searchChanged(this);
    }
    sort() {
      __searchList(this).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
      __searchChanged(this);
    }
    forEach(callback, thisArg) {
      for (const pair of __searchList(this).slice()) callback.call(thisArg, pair[1], pair[0], this);
    }
    keys() { return __searchList(this).map((pair) => pair[0])[Symbol.iterator](); }
    values() { return __searchList(this).map((pair) => pair[1])[Symbol.iterator](); }
    entries() { return __searchList(this).map((pair) => [pair[0], pair[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return __syncCall("searchSerialize", { pairs: __searchList(this) }); }
  }
  const __urlState = new WeakMap();
  const __urlApply = (url, parts) => {
    const state = __urlState.get(url);
    state.parts = parts;
    if (state.params) __searchState.get(state.params).list = __syncCall("searchParse", { init: parts.search });
  };
  class URL {
    constructor(url, base) {
      const parts = __syncCall(
        "url",
        base === undefined ? { input: String(url) } : { input: String(url), base: String(base) },
      );
      __urlState.set(this, { parts, params: undefined });
    }
    static canParse(url, base) {
      try {
        new URL(url, base);
        return true;
      } catch {
        return false;
      }
    }
    get origin() { return __urlState.get(this).parts.origin; }
    get searchParams() {
      const state = __urlState.get(this);
      if (!state.params) {
        state.params = new URLSearchParams(state.parts.search);
        __searchState.get(state.params).url = this;
      }
      return state.params;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }
  for (const property of ["href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"]) {
    Object.defineProperty(URL.prototype, property, {
      get() { return __urlState.get(this).parts[property]; },
      set(value) {
        __urlApply(this, __syncCall("urlSet", { href: this.href, property, value: String(value) }));
      },
      enumerable: true,
      configurable: true,
    });
  }
  const __cryptoKeys = new WeakMap();
  const __settle = (run) => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const __algorithmName = (algorithm) =>
    typeof algorithm === "string" ? algorithm : algorithm && typeof algorithm.name === "string" ? algorithm.name : "";
  const __requireHmac = (algorithm) => {
    if (__algorithmName(algorithm).toUpperCase() !== "HMAC") {
      throw __namedError(Error, "NotSupportedError", "fabric_exec crypto.subtle signs with HMAC only, got " + __algorithmName(algorithm));
    }
  };
  const __hmacSecret = (key, usage) => {
    const secret = __cryptoKeys.get(key);
    if (secret === undefined) throw new TypeError("key must be a CryptoKey returned by crypto.subtle.importKey");
    if (key.usages.indexOf(usage) < 0) {
      throw __namedError(Error, "InvalidAccessError", "CryptoKey usages do not include " + usage);
    }
    return secret;
  };
  const __unsupportedSubtle = (name) => () => Promise.reject(__namedError(
    Error,
    "NotSupportedError",
    "crypto.subtle." + name + " is not available in fabric_exec, which provides digest plus HMAC importKey, sign and verify; run other algorithms through omp.bash with openssl",
  ));
  const __subtle = Object.freeze({
    digest: (algorithm, data) => __settle(() =>
      __fromHex(__syncCall("digest", {
        algorithm: __algorithmName(algorithm),
        data: __toHex(__bufferBytes(data, "crypto.subtle.digest data")),
      })).buffer),
    importKey: (format, keyData, algorithm, extractable, keyUsages) => __settle(() => {
      if (format !== "raw") {
        throw __namedError(Error, "NotSupportedError", "fabric_exec crypto.subtle.importKey accepts the raw format only, got " + String(format));
      }
      __requireHmac(algorithm);
      const usages = Array.from(keyUsages ?? []);
      if (usages.length === 0) throw __namedError(Error, "SyntaxError", "HMAC keys need at least one usage");
      for (const usage of usages) {
        if (usage !== "sign" && usage !== "verify") {
          throw __namedError(Error, "SyntaxError", "HMAC key usages must be sign or verify, got " + String(usage));
        }
      }
      const bytes = __bufferBytes(keyData, "crypto.subtle.importKey keyData");
      if (bytes.length === 0) throw __namedError(Error, "DataError", "HMAC key data must not be empty");
      const hash = __syncCall("hashName", { algorithm: __algorithmName(algorithm.hash) });
      const key = Object.freeze({
        type: "secret",
        extractable: Boolean(extractable),
        algorithm: Object.freeze({ name: "HMAC", hash: Object.freeze({ name: hash }), length: bytes.length * 8 }),
        usages: Object.freeze(usages),
      });
      __cryptoKeys.set(key, __toHex(bytes));
      return key;
    }),
    sign: (algorithm, key, data) => __settle(() => {
      __requireHmac(algorithm);
      return __fromHex(__syncCall("hmac", {
        hash: key.algorithm.hash.name,
        key: __hmacSecret(key, "sign"),
        data: __toHex(__bufferBytes(data, "crypto.subtle.sign data")),
      })).buffer;
    }),
    verify: (algorithm, key, signature, data) => __settle(() => {
      __requireHmac(algorithm);
      return __syncCall("hmacVerify", {
        hash: key.algorithm.hash.name,
        key: __hmacSecret(key, "verify"),
        signature: __toHex(__bufferBytes(signature, "crypto.subtle.verify signature")),
        data: __toHex(__bufferBytes(data, "crypto.subtle.verify data")),
      });
    }),
    encrypt: __unsupportedSubtle("encrypt"),
    decrypt: __unsupportedSubtle("decrypt"),
    generateKey: __unsupportedSubtle("generateKey"),
    deriveKey: __unsupportedSubtle("deriveKey"),
    deriveBits: __unsupportedSubtle("deriveBits"),
    exportKey: __unsupportedSubtle("exportKey"),
    wrapKey: __unsupportedSubtle("wrapKey"),
    unwrapKey: __unsupportedSubtle("unwrapKey"),
  });
  const __integerArray = (array) =>
    ArrayBuffer.isView(array)
    && !(array instanceof DataView)
    && !(array instanceof Float32Array)
    && !(array instanceof Float64Array);
  const crypto = Object.freeze({
    subtle: __subtle,
    randomUUID: () => __syncCall("uuid", {}),
    getRandomValues: (array) => {
      if (!__integerArray(array)) {
        throw __namedError(TypeError, "TypeMismatchError", "crypto.getRandomValues needs an integer typed array");
      }
      if (array.byteLength > 65536) {
        throw __namedError(Error, "QuotaExceededError", "crypto.getRandomValues fills at most 65536 bytes per call");
      }
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
        .set(__fromHex(__syncCall("random", { length: array.byteLength })));
      return array;
    },
  });
  return { TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams, crypto };
}`;
