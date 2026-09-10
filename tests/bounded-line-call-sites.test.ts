import { readdirSync, readFileSync } from "node:fs";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBoundedLines } from "../src/ui/fabric-render.js";

const SRC = path.resolve(import.meta.dirname, "..", "src");

const REGISTERED_CALL_SITES: Record<string, { calls: number; surface: string }> = {
  "fabric-exec-tool.ts": {
    calls: 6,
    surface: "compact card title and description, plus the four renderResult shapes",
  },
  "ui/fabric-render.ts": {
    calls: 3,
    surface: "single and multi write-argument previews, multicall partial",
  },
  "ui/dashboard-detail.ts": {
    calls: 2,
    surface: "expanded transcript tool body and activity preview panel",
  },
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });

const callSiteCounts = (): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const file of walk(SRC)) {
    const calls = readFileSync(file, "utf8").match(/renderBoundedLines\(/g)?.length ?? 0;
    if (calls > 0) counts.set(file.slice(SRC.length + 1), calls);
  }
  return counts;
};

describe("bounded-line call-site registry", () => {
  it("holds every renderBoundedLines surface at its acknowledged call count", () => {
    expect(Object.fromEntries(callSiteCounts())).toEqual(
      Object.fromEntries(
        Object.entries(REGISTERED_CALL_SITES).map(([file, entry]) => [file, entry.calls]),
      ),
    );
  });

  it("wraps by default so no call site can opt a row back into silent clipping", () => {
    const line = "reachable ".repeat(24) + "ending";
    const unbounded = renderBoundedLines([line]).render(40);
    const bounded = renderBoundedLines([line], undefined, "off", 3).render(40);

    expect(unbounded.length).toBeGreaterThan(1);
    expect(unbounded.join("").replace(/\s+/g, " ")).toContain("ending");
    expect(unbounded.join("")).not.toContain(" …+");
    expect(bounded).toHaveLength(3);
    expect(bounded[2]).toMatch(/ …\+\d+$/);
  });

  it("keeps a blank separator row instead of dropping it", () => {
    expect(renderBoundedLines(["first", "", "second"]).render(40)).toEqual([
      "first",
      "",
      "second",
    ]);
  });
});
