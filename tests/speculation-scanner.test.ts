import { describe, expect, it } from "vitest";
import { LiteralCallScanner } from "../src/speculation/scanner.js";

describe("LiteralCallScanner", () => {
  it("detects a single-object literal call", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push('const a = await omp.read({ path: "src/index.ts" });');
    expect(found).toEqual([{ ref: "omp.read", args: { path: "src/index.ts" } }]);
  });

  it("detects zero-argument calls as {}", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push("const s = await schema.status();");
    expect(found).toEqual([{ ref: "schema.status", args: {} }]);
  });

  it("detects nested literal shapes", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push(
      'await omp.grep({ pattern: "TODO", path: "src", ignoreCase: true, context: 2, tags: ["a", 3, null] });',
    );
    expect(found).toEqual([
      {
        ref: "omp.grep",
        args: {
          pattern: "TODO",
          path: "src",
          ignoreCase: true,
          context: 2,
          tags: ["a", 3, null],
        },
      },
    ]);
  });

  it("detects several calls in one program, including Promise.all fan-out", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push(`
      const [a, b] = await Promise.all([
        omp.read({ path: "a.ts" }),
        omp.read({ path: "b.ts" }),
      ]);
      await memory.recall({ query: "speculation" });
    `);
    expect(found.map((c) => c.ref)).toEqual(["omp.read", "omp.read", "memory.recall"]);
  });

  it("builds three-segment MCP refs", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push(
      'const r = await mcp.exa.search({ query: "omp-fabric", numResults: 3 });',
    );
    expect(found).toEqual([
      { ref: "mcp.exa.search", args: { query: "omp-fabric", numResults: 3 } },
    ]);
  });

  it("rejects non-literal arguments without emitting", () => {
    const scanner = new LiteralCallScanner();
    const code = [
      "omp.read({ path: someVar })",
      "omp.read({ path: `prefix-${x}` })",
      "omp.read({ path: paths[0] })",
      "omp.read({ ...base })",
      "omp.read({ path: \"a\", other: compute() })",
    ].join(";\n") + ";";
    expect(scanner.push(code)).toEqual([]);
  });

  it("normalizes omp string-primary and positional calls like the guest bridge", () => {
    expect(new LiteralCallScanner().push('omp.grep("TODO", "src");')).toEqual([
      { ref: "omp.grep", args: { pattern: "TODO", path: "src" } },
    ]);
    expect(new LiteralCallScanner().push('omp.ls("src");')).toEqual([
      { ref: "omp.ls", args: { path: "src" } },
    ]);
    expect(new LiteralCallScanner().push('await omp.read("/abs/file.ts");')).toEqual([
      { ref: "omp.read", args: { path: "/abs/file.ts" } },
    ]);
    expect(new LiteralCallScanner().push('omp.read("/abs/file.ts", { limit: 120 });')).toEqual([
      { ref: "omp.read", args: { path: "/abs/file.ts", limit: 120 } },
    ]);
  });

  it("keeps non-omp roots on the single-object-literal convention", () => {
    const scanner = new LiteralCallScanner();
    expect(scanner.push('memory.recall("speculation");')).toEqual([]);
    expect(scanner.push('state.get("k", "extra");')).toEqual([]);
  });

  it("taints a namespace root when the program shadows it", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push(`
      const omp = { read: () => "fake" };
      omp.read({ path: "a.ts" });
      memory.recall({ query: "still fine" });
    `);
    expect(found).toEqual([{ ref: "memory.recall", args: { query: "still fine" } }]);
  });

  it("treats function parameters named like a root as shadowing", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push(`
      const run = (state) => state.get({ key: "k" });
    `);
    expect(found).toEqual([]);
  });

  it("emits each ref+args pair once across incremental pushes", () => {
    const scanner = new LiteralCallScanner();
    expect(scanner.push('const a = omp.read({ path: "a.ts" }')).toEqual([]);
    const first = scanner.push('const a = omp.read({ path: "a.ts" });\nconst b = omp.read({ path: "b.ts" });');
    expect(first.map((c) => c.args.path)).toEqual(["a.ts", "b.ts"]);
    // Re-pushed overlapping prefix must not re-emit a.ts.
    const second = scanner.push(
      'const a = omp.read({ path: "a.ts" });\nconst b = omp.read({ path: "b.ts" });\nomp.read({ path: "a.ts" });',
    );
    expect(second).toEqual([]);
  });

  it("does not scan when the appended text cannot complete a call", () => {
    const scanner = new LiteralCallScanner();
    const noop = scanner.push('const x = omp.read({ path: "a.ts"');
    expect(noop).toEqual([]);
  });

  it("detects calls under conditionals (launch is speculative; freshness gates correctness)", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push('if (docs.length > 0) { await omp.read({ path: "d.md" }); }');
    expect(found).toEqual([{ ref: "omp.read", args: { path: "d.md" } }]);
  });

  it("handles negative and fractional numbers", () => {
    const scanner = new LiteralCallScanner();
    const found = scanner.push("await state.get({ key: \"k\", offset: -2, ratio: 0.5 });");
    expect(found).toEqual([{ ref: "state.get", args: { key: "k", offset: -2, ratio: 0.5 } }]);
  });
});
