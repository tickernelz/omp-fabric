import { describe, expect, it } from "vitest";
import { CompletedOutputJournal } from "../src/completed-outputs.js";

describe("CompletedOutputJournal", () => {
  it("keeps short text whole and names the path or first command line", () => {
    const journal = new CompletedOutputJournal();
    journal.record("omp.read", { path: "/repo/a.ts" }, "export const a = 1;\n");
    journal.record("omp.bash", { cmd: "git status\ngit log" }, { ok: true, output: "clean" });
    expect(journal.entries()).toEqual([
      { ref: "omp.read", target: "/repo/a.ts", chars: 20, preview: "export const a = 1;\n" },
      { ref: "omp.bash", target: "git status", chars: 5, preview: "clean" },
    ]);
  });

  it("keeps the head and the tail of a long output and counts what it dropped", () => {
    const journal = new CompletedOutputJournal();
    const long = `${"H".repeat(450)}${"m".repeat(1_000)}${"T".repeat(250)}`;
    journal.record("omp.read", { path: "big.log" }, long);
    const [entry] = journal.entries();
    expect(entry?.chars).toBe(1_700);
    expect(entry?.preview.startsWith("H".repeat(450))).toBe(true);
    expect(entry?.preview.endsWith("T".repeat(250))).toBe(true);
    expect(entry?.preview).toContain("…[1000 chars omitted]…");
    expect(entry!.preview.length).toBeLessThan(800);
  });

  it("keeps only the latest six calls and skips empty results", () => {
    const journal = new CompletedOutputJournal();
    for (let index = 0; index < 9; index += 1) journal.record("omp.read", { path: `f${index}` }, `body ${index}`);
    journal.record("omp.write", { path: "x" }, undefined);
    journal.record("omp.write", { path: "y" }, "   ");
    expect(journal.entries().map((entry) => entry.target)).toEqual(["f3", "f4", "f5", "f6", "f7", "f8"]);
  });

  it("serializes structured results and survives values it cannot serialize", () => {
    const journal = new CompletedOutputJournal();
    journal.record("demo.call", {}, { echoed: "x" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    journal.record("demo.call", {}, cyclic);
    expect(journal.entries().map((entry) => entry.preview)).toEqual(['{"echoed":"x"}']);
  });
});
