import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseGitWorktreeAdd, tryExecuteGitWorktreeAdd } from "../src/agents/bash-worktree-add.js";
import { OmpToolsProvider } from "../src/providers/omp-tools-provider.js";

const roots: string[] = [];
const worktrees: Array<{ repository: string; path: string }> = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const initRepository = (): string => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-bash-wt-"));
  roots.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "omp-fabric-tests@example.invalid");
  git(repository, "config", "user.name", "OMP Fabric tests");
  fs.writeFileSync(path.join(repository, "README.md"), "ok\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  return fs.realpathSync(repository);
};

afterEach(() => {
  for (const worktree of worktrees.splice(0)) {
    try {
      git(worktree.repository, "worktree", "remove", "--force", worktree.path);
    } catch {
      // The test may already have removed this worktree.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("parseGitWorktreeAdd", () => {
  it("parses supported git worktree add argv", () => {
    expect(parseGitWorktreeAdd("git worktree add -b topic ./wt HEAD")).toEqual({
      branch: { flag: "-b", name: "topic" },
      detach: false,
      quiet: false,
      dest: "./wt",
      startPoint: "HEAD",
    });
    expect(parseGitWorktreeAdd("git -C ../repo worktree add --detach -q dest")).toEqual({
      gitCwd: "../repo",
      detach: true,
      quiet: true,
      dest: "dest",
    });
  });

  it("leaves unsupported shell and git syntax alone", () => {
    expect(parseGitWorktreeAdd("git worktree add -b topic ./wt && echo hi")).toBeUndefined();
    expect(parseGitWorktreeAdd("git worktree add --lock dest")).toBeUndefined();
    expect(parseGitWorktreeAdd("git worktree list")).toBeUndefined();
  });
});

describe("tryExecuteGitWorktreeAdd", () => {
  it("clone-first creates the requested worktree", async () => {
    const repository = initRepository();
    const dest = path.join(repository, "linked-wt");
    const result = await tryExecuteGitWorktreeAdd(
      { command: "git worktree add -b topic linked-wt HEAD" },
      repository,
    );
    expect(result).toBeDefined();
    worktrees.push({ repository, path: dest });
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
    expect(git(repository, "worktree", "list", "--porcelain")).toContain("branch refs/heads/topic");
  });
});

describe("OmpToolsProvider bash intercept", () => {
  it("hijacks git worktree add through omp.bash", async () => {
    const repository = initRepository();
    const dest = path.join(repository, "from-bash");
    const provider = await OmpToolsProvider.create(repository);
    const result = await provider.invoke(
      "bash",
      { command: "git worktree add -b from-bash from-bash HEAD" },
      {
        cwd: repository,
        signal: new AbortController().signal,
        parentToolCallId: "parent",
        nestedToolCallId: "fabric_test-nested",
        extensionContext: {
          cwd: repository,
          sessionManager: {
            getSessionId: () => "test-session",
            getSessionFile: () => undefined,
          },
        } as unknown as ExtensionContext,
        update: vi.fn(),
      },
    );
    worktrees.push({ repository, path: dest });
    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
  });
});
