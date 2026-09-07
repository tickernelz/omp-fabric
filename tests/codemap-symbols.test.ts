import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSymbolIndex } from "../src/codemap/symbols.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const RUBY_SOURCE = [
  'require "json"',
  "",
  "module Greeter",
  "  class Hello",
  "    def initialize(name)",
  "      @name = name",
  "    end",
  "",
  "    def greet",
  '      puts "hi"',
  "    end",
  "  end",
  "end",
  "",
  "MAX_RETRIES = 3",
  "",
].join("\n");

const DEDUPE_SOURCE = [
  "export const alpha = (value: number) => value;",
  "export class Widget {",
  "  size = 1;",
  "}",
  "",
].join("\n");

let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "omp-fabric-codemap-"));
  await mkdir(path.join(fixture, "sub"), { recursive: true });
  await writeFile(path.join(fixture, "dedupe.ts"), DEDUPE_SOURCE, "utf8");
  await writeFile(path.join(fixture, "sample.rb"), RUBY_SOURCE, "utf8");
  await writeFile(
    path.join(fixture, "sub", "nested.ts"),
    "export function nested() {\n  return 1;\n}\n",
    "utf8",
  );
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("buildSymbolIndex", () => {
  it(
    "indexes this repository's own source tree",
    async () => {
      const index = await buildSymbolIndex({
        root: path.join(repoRoot, "src"),
        maxFiles: 20_000,
        maxSymbols: 400_000,
      });

      expect(index.truncated).toBe(false);
      expect(index.files.length).toBeGreaterThanOrEqual(200);
      expect(index.symbols.length).toBeGreaterThanOrEqual(5_000);
      expect(index.elapsedMs).toBeLessThan(15_000);
      expect(index.languages.ts).toBe(index.files.length);

      const budget = index.symbols.filter((symbol) => symbol.name === "modelOutputBudget");
      expect(budget).toEqual([
        {
          file: "output-budget.ts",
          line: 8,
          kind: "fn",
          name: "modelOutputBudget",
          exported: true,
        },
      ]);

      let rendered = 0;
      let previous = "";
      for (const symbol of index.symbols) {
        if (symbol.file !== previous) {
          rendered += symbol.file.length + 1;
          previous = symbol.file;
        }
        rendered += String(symbol.line).length + symbol.kind.length + symbol.name.length + 3;
      }

      let raw = 0;
      for (const file of index.files) raw += (await stat(path.join(repoRoot, "src", file))).size;

      console.log(
        JSON.stringify({
          symbols: index.symbols.length,
          files: index.files.length,
          rawBytes: raw,
          renderedBytes: rendered,
          ratio: Number((raw / rendered).toFixed(2)),
          elapsedMs: index.elapsedMs,
        }),
      );

      expect(raw / rendered).toBeGreaterThan(11);
    },
    120_000,
  );

  it("collapses one source line matched by several patterns into a single symbol", async () => {
    const index = await buildSymbolIndex({
      root: fixture,
      glob: "dedupe.ts",
      maxFiles: 16,
      maxSymbols: 256,
    });

    expect(index.files).toEqual(["dedupe.ts"]);
    expect(index.symbols.filter((symbol) => symbol.line === 1)).toEqual([
      { file: "dedupe.ts", line: 1, kind: "fn", name: "alpha", exported: true },
    ]);
    expect(index.symbols.filter((symbol) => symbol.name === "Widget")).toEqual([
      { file: "dedupe.ts", line: 2, kind: "class", name: "Widget", exported: true },
    ]);
  });

  it("summarizes languages that have no pattern table", async () => {
    const index = await buildSymbolIndex({
      root: fixture,
      glob: "*.rb",
      maxFiles: 16,
      maxSymbols: 256,
    });

    expect(index.fallbackFiles).toEqual(["sample.rb"]);
    expect(index.languages).toEqual({ rb: 1 });

    const byName = new Map(index.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get("Hello")).toEqual({
      file: "sample.rb",
      line: 4,
      kind: "class",
      name: "Hello",
      exported: true,
    });
    expect(byName.get("MAX_RETRIES")?.kind).toBe("const");
    expect(byName.get("greet")?.kind).toBe("fn");
    expect(byName.has("json")).toBe(false);
    expect(byName.has("end")).toBe(false);
  });

  it("restricts discovery to the requested glob", async () => {
    const index = await buildSymbolIndex({
      root: fixture,
      glob: "sub/**/*.ts",
      maxFiles: 16,
      maxSymbols: 256,
    });

    expect(index.files).toEqual(["sub/nested.ts"]);
    expect(index.symbols).toEqual([
      { file: "sub/nested.ts", line: 1, kind: "fn", name: "nested", exported: true },
    ]);
  });

  it("reports truncation when the file or symbol ceiling bites", async () => {
    const cappedFiles = await buildSymbolIndex({
      root: fixture,
      maxFiles: 1,
      maxSymbols: 256,
    });
    expect(cappedFiles.files).toHaveLength(1);
    expect(cappedFiles.truncated).toBe(true);

    const cappedSymbols = await buildSymbolIndex({
      root: fixture,
      maxFiles: 16,
      maxSymbols: 2,
    });
    expect(cappedSymbols.symbols).toHaveLength(2);
    expect(cappedSymbols.truncated).toBe(true);
  });

  it("aborts when the caller's signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("index cancelled"));

    await expect(
      buildSymbolIndex({
        root: fixture,
        maxFiles: 16,
        maxSymbols: 256,
        signal: controller.signal,
      }),
    ).rejects.toThrow("index cancelled");
  });
});
