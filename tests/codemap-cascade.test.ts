import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coChange } from "../src/codemap/cascade.js";

const roots: string[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const initRepository = (label: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omp-fabric-cascade-${label}-`));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "omp-fabric-tests@example.invalid");
  git(root, "config", "user.name", "OMP Fabric tests");
  return fs.realpathSync(root);
};

const commit = (root: string, message: string, files: string[]): void => {
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${message}\n`);
    git(root, "add", "--", file);
  }
  git(root, "commit", "-qm", message);
};

let affinity = "";
let bulkRoot = "";
let plainDirectory = "";

const ACCENTED = "src/\u00e9.ts";

beforeAll(() => {
  affinity = initRepository("affinity");
  commit(affinity, "c1", ["a.ts", "b.ts", "d.ts", ACCENTED]);
  commit(affinity, "c2", ["a.ts", "b.ts", "d.ts", ACCENTED]);
  commit(affinity, "c3", ["a.ts", "b.ts", "d.ts", ACCENTED]);
  commit(affinity, "c4", ["a.ts", "d.ts"]);
  commit(affinity, "c5", ["a.ts", "d.ts"]);
  commit(affinity, "c6", ["c.ts", "d.ts"]);
  commit(affinity, "c7", ["c.ts", "d.ts"]);
  commit(affinity, "c8", ["d.ts"]);
  commit(affinity, "c9", ["d.ts"]);
  commit(affinity, "c10", ["d.ts"]);

  bulkRoot = initRepository("bulk");
  commit(bulkRoot, "pair", ["a.ts", "b.ts"]);
  const bulkFiles = ["a.ts"];
  for (let index = 0; index < 150; index += 1) {
    bulkFiles.push(`vendor/bulk-${String(index).padStart(3, "0")}.ts`);
  }
  commit(bulkRoot, "vendor drop", bulkFiles);

  plainDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-cascade-plain-")));
  roots.push(plainDirectory);
});

afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("coChange", () => {
  it("ranks a true co-change partner above a ubiquitous file", async () => {
    const graph = await coChange({ root: affinity, seeds: ["a.ts"], maxCommits: 100, limit: 20 });

    expect(graph.unavailable).toBeUndefined();
    expect(graph.commitsScanned).toBe(10);
    expect(graph.truncated).toBe(false);
    expect(graph.seeds).toEqual(["a.ts"]);

    const first = graph.edges[0];
    const ubiquitous = graph.edges.find((edge) => edge.file === "d.ts");
    expect(first?.file).toBe("b.ts");
    expect(ubiquitous).toBeDefined();
    expect(ubiquitous?.score).toBeLessThan(first?.score ?? 0);

    expect(ubiquitous?.commits).toBeGreaterThan(first?.commits ?? 0);

    expect(graph.edges.some((edge) => edge.file === "c.ts")).toBe(false);
    expect(first?.score).toBeCloseTo(3 / Math.sqrt(15), 10);
    expect(ubiquitous?.score).toBeCloseTo(5 / Math.sqrt(50), 10);
  });

  it("decodes git quoted paths for non-ascii names", async () => {
    const graph = await coChange({ root: affinity, seeds: ["a.ts"], maxCommits: 100, limit: 20 });
    const accented = graph.edges.find((edge) => edge.file === ACCENTED);
    expect(accented).toBeDefined();
    expect(accented?.commits).toBe(3);
  });

  it("resolves seeds given as absolute paths and from a subdirectory", async () => {
    const graph = await coChange({
      root: path.join(affinity, "src"),
      seeds: [path.join(affinity, "a.ts")],
      maxCommits: 100,
      limit: 20,
    });
    expect(graph.seeds).toEqual(["a.ts"]);
    expect(graph.edges[0]?.file).toBe("b.ts");
  });

  it("caps edges at the requested limit and reports truncation", async () => {
    const graph = await coChange({ root: affinity, seeds: ["a.ts"], maxCommits: 100, limit: 1 });
    expect(graph.edges).toHaveLength(1);
    expect(graph.truncated).toBe(true);
    expect(graph.edges[0]?.file).toBe("b.ts");
  });

  it("honours maxCommits", async () => {
    const graph = await coChange({ root: affinity, seeds: ["a.ts"], maxCommits: 3, limit: 20 });
    expect(graph.commitsScanned).toBe(3);
  });

  it("excludes bulk commits so they create no affinity", async () => {
    const graph = await coChange({ root: bulkRoot, seeds: ["a.ts"], maxCommits: 100, limit: 200 });
    expect(graph.commitsScanned).toBe(1);
    expect(graph.edges.map((edge) => edge.file)).toEqual(["b.ts"]);
    expect(graph.edges.some((edge) => edge.file.startsWith("vendor/"))).toBe(false);
  });

  it("reports unavailable instead of throwing outside a git repository", async () => {
    const graph = await coChange({ root: plainDirectory, seeds: ["a.ts"], maxCommits: 100, limit: 20 });
    expect(graph.unavailable).toBeTruthy();
    expect(graph.edges).toEqual([]);
    expect(graph.commitsScanned).toBe(0);
    expect(graph.truncated).toBe(false);
  });

  it("reports unavailable for a missing root and for empty seeds", async () => {
    const missing = await coChange({
      root: path.join(plainDirectory, "nope"),
      seeds: ["a.ts"],
      maxCommits: 10,
      limit: 5,
    });
    expect(missing.unavailable).toBeTruthy();

    const seedless = await coChange({ root: affinity, seeds: [], maxCommits: 10, limit: 5 });
    expect(seedless.unavailable).toBeTruthy();
    expect(seedless.edges).toEqual([]);
  });

  it("reports unavailable for a repository without commits", async () => {
    const fresh = initRepository("fresh");
    const graph = await coChange({ root: fresh, seeds: ["a.ts"], maxCommits: 10, limit: 5 });
    expect(graph.unavailable).toBeTruthy();
    expect(graph.edges).toEqual([]);
  });
});
