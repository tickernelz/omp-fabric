import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolIndex } from "../src/codemap/symbols.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const bigTree = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-codemap-budget-"));
  roots.push(root);
  for (let dir = 0; dir < 40; dir++) {
    const sub = path.join(root, `pkg${dir}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let file = 0; file < 25; file++) {
      const body = Array.from({ length: 40 }, (_, n) => `export function fn${dir}_${file}_${n}(a: number) { return a + ${n}; }`).join("\n");
      fs.writeFileSync(path.join(sub, `m${file}.ts`), body, "utf8");
    }
  }
  return root;
};

describe("codemap index time budget", () => {
  it("stops on the budget and reports truncation", async () => {
    const root = bigTree();
    const started = Date.now();
    const index = await buildSymbolIndex({ root, maxFiles: 100_000, maxSymbols: 5_000_000, maxMs: 1 });
    expect(index.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("completes without a budget and reports no truncation", async () => {
    const root = bigTree();
    const index = await buildSymbolIndex({ root, maxFiles: 100_000, maxSymbols: 5_000_000 });
    expect(index.truncated).toBe(false);
    expect(index.symbols.length).toBeGreaterThan(1_000);
  });

  it("a generous budget does not truncate", async () => {
    const root = bigTree();
    const index = await buildSymbolIndex({ root, maxFiles: 100_000, maxSymbols: 5_000_000, maxMs: 600_000 });
    expect(index.truncated).toBe(false);
  });
});
