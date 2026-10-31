import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolIndex } from "../src/codemap/symbols.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const unbounded = { maxFiles: 100_000, maxSymbols: 5_000_000 };

describe("codemap budget is honoured on wall time", () => {
  it("returns a truncated map instead of throwing or overrunning", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-budget-wall-"));
    roots.push(root);
    for (let dir = 0; dir < 20; dir++) {
      const sub = path.join(root, `pkg${dir}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let file = 0; file < 15; file++) {
        const body = Array.from({ length: 60 }, (_, n) => `export function fn${dir}_${file}_${n}(a: number) { return a + ${n}; }`).join("\n");
        fs.writeFileSync(path.join(sub, `m${file}.ts`), body, "utf8");
      }
    }
    await buildSymbolIndex({ root, ...unbounded });
    const fullStarted = Date.now();
    const full = await buildSymbolIndex({ root, ...unbounded });
    const fullMs = Date.now() - fullStarted;
    expect(full.truncated).toBe(false);

    const budget = Math.max(20, Math.floor(fullMs / 4));
    const started = Date.now();
    const index = await buildSymbolIndex({ root, ...unbounded, maxMs: budget });
    const wall = Date.now() - started;

    expect(index.truncated).toBe(true);
    expect(index.symbols.length).toBeLessThan(full.symbols.length);
    expect(wall).toBeLessThan(budget * 6);
  });
});
