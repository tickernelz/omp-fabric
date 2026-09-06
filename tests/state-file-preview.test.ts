import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStateFilePreview } from "../src/ui/state-file-preview.js";
import type { FabricUiStateEntry } from "../src/ui/types.js";

const roots: string[] = [];

const root = (): string => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-state-file-"));
  roots.push(value);
  return value;
};

const entry = (key: string, value: unknown = {}): FabricUiStateEntry => ({
  key,
  label: key,
  status: "state",
  value,
  version: 1,
  updatedAt: Date.now(),
});

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("state file previews", () => {
  it("resolves complexity-ledger files and detects their Shiki language", () => {
    const cwd = root();
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "worker.ts"), "export const worker = true;\n");

    expect(loadStateFilePreview(entry("state/complexity/src/worker.ts"), cwd)).toMatchObject({
      path: "src/worker.ts",
      language: "typescript",
      lines: ["export const worker = true;", ""],
      truncated: false,
    });
  });

  it("accepts explicit project-relative file metadata", () => {
    const cwd = root();
    fs.writeFileSync(path.join(cwd, "status.json"), "{\"ready\":true}\n");

    expect(loadStateFilePreview(entry("project/status", { file: "status.json" }), cwd)).toMatchObject({
      path: "status.json",
      language: "json",
      content: "{\"ready\":true}\n",
    });
  });

  it("rejects absolute paths, traversal, symlink escapes, and binary files", () => {
    const cwd = root();
    const outside = root();
    fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = true;\n");
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(cwd, "escape.ts"));
    fs.writeFileSync(path.join(cwd, "binary.ts"), Buffer.from([0, 1, 2]));

    expect(loadStateFilePreview(entry("project/absolute", { file: path.join(outside, "secret.ts") }), cwd)).toBeUndefined();
    expect(loadStateFilePreview(entry("project/traversal", { file: "../secret.ts" }), cwd)).toBeUndefined();
    expect(loadStateFilePreview(entry("project/symlink", { file: "escape.ts" }), cwd)).toBeUndefined();
    expect(loadStateFilePreview(entry("project/binary", { file: "binary.ts" }), cwd)).toBeUndefined();
  });
});
