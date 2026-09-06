import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotWorkspace } from "../src/schema/workspace.js";

const roots: string[] = [];
const temporary = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-schema-snapshot-"));
  roots.push(root);
  return root;
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Schema workspace fingerprints", () => {
  it("deterministically covers Git HEAD, index, tracked worktree content, and untracked content", () => {
    const cwd = temporary();
    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "schema@example.invalid");
    git(cwd, "config", "user.name", "Schema Test");
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "one\n");
    git(cwd, "add", "tracked.txt");
    git(cwd, "commit", "-qm", "initial");

    const initial = snapshotWorkspace(cwd);
    expect(initial.git).toBe(true);
    expect(snapshotWorkspace(cwd).fingerprint).toBe(initial.fingerprint);

    fs.writeFileSync(path.join(cwd, "tracked.txt"), "two\n");
    const worktree = snapshotWorkspace(cwd);
    expect(worktree.fingerprint).not.toBe(initial.fingerprint);

    git(cwd, "add", "tracked.txt");
    const indexed = snapshotWorkspace(cwd);
    expect(indexed.indexDigest).not.toBe(initial.indexDigest);
    expect(indexed.fingerprint).not.toBe(worktree.fingerprint);

    fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n");
    const untracked = snapshotWorkspace(cwd);
    expect(untracked.entries["untracked.txt"]).toMatch(/^file:/);
    expect(untracked.fingerprint).not.toBe(indexed.fingerprint);

    git(cwd, "commit", "-qm", "second");
    const committed = snapshotWorkspace(cwd);
    expect(committed.head).not.toBe(initial.head);
    expect(committed.fingerprint).not.toBe(untracked.fingerprint);
  }, 20_000);

  it("uses a bounded deterministic project-file fallback outside Git and excludes host metadata", () => {
    const cwd = temporary();
    const mesh = path.join(cwd, ".omp", "fabric", "mesh");
    fs.mkdirSync(mesh, { recursive: true });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    fs.writeFileSync(path.join(mesh, "state.json"), "one");
    const first = snapshotWorkspace(cwd, [mesh]);
    expect(first.git).toBe(false);
    expect(first.entries).toEqual({ "a.txt": expect.stringMatching(/^file:/) });
    fs.writeFileSync(path.join(mesh, "state.json"), "two");
    expect(snapshotWorkspace(cwd, [mesh]).fingerprint).toBe(first.fingerprint);
    fs.writeFileSync(path.join(cwd, "a.txt"), "b");
    expect(snapshotWorkspace(cwd, [mesh]).fingerprint).not.toBe(first.fingerprint);
  });
});
