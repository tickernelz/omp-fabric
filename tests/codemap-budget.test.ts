import { describe, expect, it } from "vitest";
import { assembleMap } from "../src/codemap/budget.js";
import type { CoChangeGraph, CodeSymbol, SymbolIndex } from "../src/codemap/types.js";

const LEGEND = "# f=fn c=class i=iface t=type v=const e=enum m=method";

const indexOf = (symbols: CodeSymbol[]): SymbolIndex => ({
  root: "/repo",
  symbols,
  files: [...new Set(symbols.map((symbol) => symbol.file))],
  languages: { ts: symbols.length },
  fallbackFiles: [],
  truncated: false,
  elapsedMs: 0,
});

const largeSymbols = (): CodeSymbol[] => {
  const symbols: CodeSymbol[] = [];
  for (let file = 0; file < 100; file++) {
    const path = `src/pkg${String(file).padStart(2, "0")}/module.ts`;
    for (let ordinal = 0; ordinal < 20; ordinal++) {
      symbols.push({
        file: path,
        line: ordinal * 7 + 1,
        kind: ordinal % 3 === 0 ? "class" : "fn",
        name: `symbol${file}_${ordinal}`,
        exported: ordinal % 2 === 0,
      });
    }
  }
  return symbols;
};

const modSymbols = (): CodeSymbol[] => {
  const symbols: CodeSymbol[] = [];
  for (let file = 0; file < 40; file++) {
    const path = `src/mod/file-${String(file).padStart(2, "0")}.ts`;
    for (let ordinal = 0; ordinal < 12; ordinal++) {
      symbols.push({
        file: path,
        line: ordinal * 5 + 2,
        kind: "fn",
        name: `handler${String(file).padStart(2, "0")}${ordinal}`,
        exported: ordinal % 2 === 0,
      });
    }
  }
  return symbols;
};

const OBSCURE_FILE = "src/obscure/deep/nested/telemetry-sink.ts";
const ZETA_FILE = "src/zeta/unrelated-widget.ts";

const budgetFor = (symbols: CodeSymbol[], files: string[]): number =>
  assembleMap({
    index: indexOf(symbols.filter((symbol) => files.includes(symbol.file))),
    maxTokens: 1_000_000,
  }).tokensEstimated;

describe("assembleMap budget", () => {
  it("keeps the rendered text inside the token ceiling", () => {
    const symbols = largeSymbols();
    const result = assembleMap({ index: indexOf(symbols), maxTokens: 200 });

    expect(result.tokensEstimated).toBeLessThanOrEqual(200);
    expect(result.text.startsWith(`${LEGEND}\n`)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(800);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(800);
    expect(result.truncated).toBe(true);
    expect(result.symbolsShown).toBeGreaterThan(0);
    expect(result.symbolsShown + result.omittedSymbols).toBe(2_000);
    expect(result.filesShown + result.omittedFiles).toBe(100);
    expect(result.text.endsWith("\n")).toBe(true);
    expect(result.text.slice(0, -1).split("\n").some((line) => line.length === 0)).toBe(false);
  });

  it("emits the whole index and reports no omission when the budget is ample", () => {
    const symbols = largeSymbols();
    const result = assembleMap({ index: indexOf(symbols), maxTokens: 1_000_000 });

    expect(result.truncated).toBe(false);
    expect(result.omittedFiles).toBe(0);
    expect(result.omittedSymbols).toBe(0);
    expect(result.filesShown).toBe(100);
    expect(result.symbolsShown).toBe(2_000);
    expect(result.text.startsWith(`${LEGEND}\n`)).toBe(true);
    expect(result.text.split(LEGEND).length).toBe(2);
    expect(result.text).toContain("src/pkg00/module.ts\n1 c symbol0_0\n");
  });

  it("promotes a low-ranked file only when the focus names it", () => {
    const symbols = [
      ...modSymbols(),
      {
        file: OBSCURE_FILE,
        line: 12,
        kind: "fn" as const,
        name: "flushTelemetryBuffer",
        exported: true,
      },
    ];
    const index = indexOf(symbols);
    const maxTokens = budgetFor(symbols, [OBSCURE_FILE, "src/mod/file-00.ts"]);

    const focused = assembleMap({ index, maxTokens, focus: "telemetry sink" });
    expect(focused.text).toContain(`${OBSCURE_FILE}\n12 f flushTelemetryBuffer\n`);
    expect(focused.text).toContain("src/mod/file-00.ts\n");

    const unfocused = assembleMap({ index, maxTokens });
    expect(unfocused.text).not.toContain(OBSCURE_FILE);
    expect(unfocused.text).toContain("src/mod/file-00.ts\n");
  });

  it("surfaces a cascade neighbour whose name matches nothing in the focus", () => {
    const zeta: CodeSymbol[] = [];
    for (let ordinal = 0; ordinal < 6; ordinal++) {
      zeta.push({
        file: ZETA_FILE,
        line: ordinal * 9 + 3,
        kind: "fn",
        name: `paintWidget${ordinal}`,
        exported: ordinal % 2 === 0,
      });
    }
    const symbols = [...modSymbols(), ...zeta];
    const index = indexOf(symbols);
    const maxTokens = budgetFor(symbols, ["src/mod/file-33.ts", ZETA_FILE]);
    const cascade: CoChangeGraph = {
      seeds: ["src/mod/file-33.ts"],
      edges: [{ file: ZETA_FILE, score: 0.9, commits: 12 }],
      commitsScanned: 200,
      truncated: false,
    };

    const withCascade = assembleMap({ index, maxTokens, focus: "file-33", cascade });
    expect(withCascade.text).toContain("src/mod/file-33.ts\n");
    expect(withCascade.text).toContain(`${ZETA_FILE}\n`);

    const withoutCascade = assembleMap({ index, maxTokens, focus: "file-33" });
    expect(withoutCascade.text).toContain("src/mod/file-33.ts\n");
    expect(withoutCascade.text).not.toContain(ZETA_FILE);
  });

  it("returns byte-identical text for identical requests", () => {
    const index = indexOf(largeSymbols());
    const cascade: CoChangeGraph = {
      seeds: ["src/pkg07/module.ts"],
      edges: [
        { file: "src/pkg42/module.ts", score: 0.8, commits: 9 },
        { file: "src/pkg11/module.ts", score: 0.4, commits: 4 },
      ],
      commitsScanned: 500,
      truncated: false,
    };
    const request = { index, maxTokens: 320, focus: "symbol42 module", cascade } as const;

    const first = assembleMap({ ...request });
    const second = assembleMap({ ...request });

    expect(second.text).toBe(first.text);
    expect(second).toEqual(first);
  });

  it("gives the last slot inside a partially fitting file to an exported symbol", () => {
    const symbols: CodeSymbol[] = [
      { file: "src/a.ts", line: 10, kind: "fn", name: "aaa", exported: false },
      { file: "src/a.ts", line: 20, kind: "fn", name: "bbb", exported: true },
    ];
    const result = assembleMap({ index: indexOf(symbols), maxTokens: 5 });

    expect(result.text).toBe("src/a.ts\n20 f bbb\n");
    expect(result.text.length).toBeLessThanOrEqual(20);
    expect(result.symbolsShown).toBe(1);
    expect(result.omittedSymbols).toBe(1);
    expect(result.omittedFiles).toBe(0);
    expect(result.filesShown).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("never returns to empty at a larger ceiling once a smaller one produced a map", () => {
    const symbols: CodeSymbol[] = [];
    for (let file = 0; file < 12; file++) {
      for (let ordinal = 0; ordinal < 4; ordinal++) {
        symbols.push({
          file: `src/mod${file}.ts`,
          line: ordinal * 3 + 1,
          kind: "fn",
          name: `fnName${file}${ordinal}`,
          exported: ordinal % 2 === 0,
        });
      }
    }
    const index = indexOf(symbols);

    let firstProducing = -1;
    const blankedAfterOutput: number[] = [];
    for (let ceiling = 0; ceiling <= 64; ceiling++) {
      const result = assembleMap({ index, maxTokens: ceiling });
      expect(result.text.length).toBeLessThanOrEqual(ceiling * 4);
      if (result.text.includes(LEGEND)) expect(result.filesShown).toBeGreaterThan(0);
      if (result.text.length > 0) {
        if (firstProducing < 0) firstProducing = ceiling;
      } else if (firstProducing >= 0) {
        blankedAfterOutput.push(ceiling);
      }
    }

    expect(firstProducing).toBeGreaterThan(0);
    expect(blankedAfterOutput).toEqual([]);
  });

  it("omits everything and stays empty when no budget is available", () => {
    const result = assembleMap({ index: indexOf(modSymbols()), maxTokens: 0 });

    expect(result.text).toBe("");
    expect(result.tokensEstimated).toBe(0);
    expect(result.filesShown).toBe(0);
    expect(result.symbolsShown).toBe(0);
    expect(result.omittedFiles).toBe(40);
    expect(result.omittedSymbols).toBe(480);
    expect(result.truncated).toBe(true);
  });
});
