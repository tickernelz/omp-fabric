import { describe, expect, it } from "vitest";
import { PartialCodeFieldExtractor } from "../src/speculation/partial-json.js";

const pushAll = (extractor: PartialCodeFieldExtractor, chunks: string[]): void => {
  for (const chunk of chunks) extractor.push(chunk);
};

describe("PartialCodeFieldExtractor", () => {
  it("extracts the code field from a complete argument blob", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    extractor.push(JSON.stringify({ code: "const a = 1;", display: "x" }));
    expect(extractor.code).toBe("const a = 1;");
    expect(extractor.complete).toBe(true);
  });

  it("decodes across arbitrarily chunked deltas including escapes", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    pushAll(extractor, [
      '{"cod',
      'e": "const x = omp.read({ p',
      'ath: \\"sr',
      'c/a.ts\\" });\\n"',
      ' "display": "preview"}',
    ]);
    expect(extractor.code).toBe('const x = omp.read({ path: "src/a.ts" });\n');
    expect(extractor.complete).toBe(true);
  });

  it("handles unicode escapes split across deltas", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    pushAll(extractor, ['{"code": "a\\u0', '041b\\', 'u0042"}']);
    expect(extractor.code).toBe("aAbB");
  });

  it("does not match \"code\" inside an earlier escaped string value", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    extractor.push(JSON.stringify({
      display: '{"code": "decoy"}',
      code: "real();",
    }));
    expect(extractor.code).toBe("real();");
  });

  it("returns undefined before the key appears", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    extractor.push('{"display": "hel');
    expect(extractor.code).toBeUndefined();
  });

  it("ignores bytes after the code string closes", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    pushAll(extractor, ['{"code": "done()"', ', "strings": {"k": "omp.read({path:\\\"z\\"})"}}']);
    expect(extractor.code).toBe("done()");
    // Later fragments are ignored: the extractor completed the code field.
    expect(extractor.complete).toBe(true);
  });

  it("stops permanently once the buffer cap is exceeded", () => {
    const extractor = new PartialCodeFieldExtractor(32);
    extractor.push('{"code": "' + "x".repeat(64));
    expect(extractor.code).toBeUndefined();
    extractor.push('"}');
    expect(extractor.code).toBeUndefined();
  });

  it("fails closed on bare control characters", () => {
    const extractor = new PartialCodeFieldExtractor(1_000_000);
    // Raw newline inside a JSON string is invalid; the extractor must not
    // mis-decode it into candidates.
    extractor.push('{"code": "a\nb"}');
    expect(extractor.complete).toBe(false);
    // Decoder failed: further pushes cannot resurrect garbage.
    expect(extractor.code).toBe("a");
  });
});
