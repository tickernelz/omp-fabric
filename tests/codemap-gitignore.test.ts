import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolIndex } from "../src/codemap/symbols.js";

const roots: string[] = [];

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-codemap-ignore-"));
  roots.push(dir);
  return dir;
};

const write = (root: string, relative: string, body: string): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
};

const SOURCE = "export const marker = 1;\nexport function helper() { return marker; }\n";

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("codemap file discovery", () => {
  it("keeps gitignored build artifacts out of the index", async () => {
    const root = scratch();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    write(root, ".gitignore", "generated\n");
    write(root, "src/kept.ts", SOURCE);
    write(root, "generated/ignored.ts", SOURCE);
    write(root, "generated/nested/deep.ts", SOURCE);

    const index = await buildSymbolIndex({ root, maxFiles: 500, maxSymbols: 5_000 });

    expect(index.files).toContain("src/kept.ts");
    expect(index.files.some((file) => file.startsWith("generated/"))).toBe(false);
    expect(index.symbols.some((symbol) => symbol.file.startsWith("generated/"))).toBe(false);
  });

  it("indexes untracked files that are not ignored", async () => {
    const root = scratch();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    write(root, "src/untracked.ts", SOURCE);

    const index = await buildSymbolIndex({ root, maxFiles: 500, maxSymbols: 5_000 });

    expect(index.files).toContain("src/untracked.ts");
  });

  it("falls back to a filesystem walk outside a git repository", async () => {
    const root = scratch();
    write(root, "src/plain.ts", SOURCE);
    write(root, "node_modules/pkg/index.ts", SOURCE);

    const index = await buildSymbolIndex({ root, maxFiles: 500, maxSymbols: 5_000 });

    expect(index.files).toContain("src/plain.ts");
    expect(index.files.some((file) => file.startsWith("node_modules/"))).toBe(false);
  });
});
