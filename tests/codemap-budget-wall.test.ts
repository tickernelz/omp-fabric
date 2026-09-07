import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolIndex } from "../src/codemap/symbols.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe("codemap budget is honoured on wall time", () => {
  it("returns a truncated map instead of throwing or overrunning", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-budget-wall-"));
    roots.push(root);
    for (let dir = 0; dir < 60; dir++) {
      const sub = path.join(root, `pkg${dir}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let file = 0; file < 30; file++) {
        const body = Array.from({ length: 60 }, (_, n) => `export function fn${dir}_${file}_${n}(a: number) { return a + ${n}; }`).join("\n");
        fs.writeFileSync(path.join(sub, `m${file}.ts`), body, "utf8");
      }
    }
    const budget = 400;
    const started = Date.now();
    const index = await buildSymbolIndex({ root, maxFiles: 100_000, maxSymbols: 5_000_000, maxMs: budget });
    const wall = Date.now() - started;
    expect(index.truncated).toBe(true);
    expect(wall).toBeLessThan(budget * 6);
  });
});
