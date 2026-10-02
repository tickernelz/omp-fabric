import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addCloneFirstWorktree } from "../src/agents/clone-first-worktree.js";
import { ensureFabricStateExclude, FABRIC_STATE_EXCLUDE, fabricWorktreePath } from "../src/agents/worktree-paths.js";
import { WorktreeManager } from "../src/agents/worktree-manager.js";

const roots: string[] = [];
const worktrees: Array<{ repository: string; path: string }> = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const initRepository = (): string => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-cow-wt-"));
  roots.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "omp-fabric-tests@example.invalid");
  git(repository, "config", "user.name", "OMP Fabric tests");
  git(repository, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repository, "README.md"), "tracked head\n");
  fs.writeFileSync(path.join(repository, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(repository, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repository, "node_modules", "pkg", "index.js"), "artifact\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  fs.writeFileSync(path.join(repository, "README.md"), "dirty working tree\n");
  return fs.realpathSync.native(repository);
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

describe("clone-first worktrees", () => {
  it("creates a managed worktree under .omp/fabric/worktrees and keeps ignored artifacts", async () => {
    const repository = initRepository();
    const dest = fabricWorktreePath(repository, "agentid0123456789abcdef012345");
    const result = await addCloneFirstWorktree({
      gitRoot: repository,
      dest,
      branch: { flag: "-b", name: "omp-fabric/clone-test-agentid01" },
      startPoint: "HEAD",
      quiet: true,
    });
    worktrees.push({ repository, path: dest });

    expect(fs.realpathSync(dest)).toBe(fs.realpathSync(path.join(repository, ".omp", "fabric", "worktrees", "agentid0123456789abcdef012345")));
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("tracked head\n");
    const exclude = git(repository, "rev-parse", "--git-path", "info/exclude").trim();
    expect(fs.readFileSync(path.resolve(repository, exclude), "utf8")).toContain(FABRIC_STATE_EXCLUDE);
    if (result.cloned) {
      expect(fs.readFileSync(path.join(dest, "node_modules", "pkg", "index.js"), "utf8")).toBe("artifact\n");
    }
  });

  it("keeps fabric state untracked from any subdirectory and adds the rule once", async () => {
    const repository = initRepository();
    git(repository, "checkout", "--", "README.md");
    const nested = path.join(repository, "sub", "deep");
    fs.mkdirSync(path.join(nested, ".omp", "fabric", "mesh"), { recursive: true });
    fs.writeFileSync(path.join(nested, ".omp", "fabric", "mesh", "state.json"), "{}\n");
    fs.mkdirSync(path.join(repository, ".omp", "fabric"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".omp", "fabric", "mcp-cache.json"), "{}\n");
    expect(git(repository, "status", "--porcelain", "--untracked-files=all")).not.toBe("");

    await ensureFabricStateExclude(nested);
    await ensureFabricStateExclude(repository);

    expect(git(repository, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const exclude = fs.readFileSync(path.resolve(repository, git(repository, "rev-parse", "--git-path", "info/exclude").trim()), "utf8");
    expect(exclude.split("\n").filter((line) => line === FABRIC_STATE_EXCLUDE)).toHaveLength(1);
  });

  it("skips a directory outside any git repository without running git", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-no-git-"));
    roots.push(plain);
    await expect(ensureFabricStateExclude(plain)).resolves.toBeUndefined();
    expect(fs.readdirSync(plain)).toEqual([]);
  });

  it("places WorktreeManager leases on the managed path", async () => {
    const repository = initRepository();
    const manager = new WorktreeManager();
    const lease = await manager.create("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", repository, "reviewer");
    worktrees.push({ repository, path: lease.path });
    expect(fs.realpathSync(lease.path)).toBe(
      fs.realpathSync(fabricWorktreePath(repository, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
    );
    await manager.cleanup("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true);
  });
});
