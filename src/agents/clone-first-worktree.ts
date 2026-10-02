import fs from "node:fs";
import path from "node:path";
import { cloneTree, CowUnavailableError, CLONE_SKIP_PREFIXES } from "./cow-clone.js";
import { executeFile } from "./transports/process-utils.js";
import { ensureFabricStateExclude, isFabricWorktreePath } from "./worktree-paths.js";

export interface CloneFirstWorktreeAdd {
  gitRoot: string;
  dest: string;
  branch?: { flag: "-b" | "-B"; name: string };
  detach?: boolean;
  quiet?: boolean;
  startPoint?: string;
}

export interface CloneFirstWorktreeResult {
  cloned: boolean;
  message: string;
}

export const addCloneFirstWorktree = async (
  options: CloneFirstWorktreeAdd,
): Promise<CloneFirstWorktreeResult> => {
  const dest = options.dest;
  if (isFabricWorktreePath(dest, path.basename(dest))) {
    await ensureFabricStateExclude(options.gitRoot);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = ["worktree", "add", "--no-checkout"];
  if (options.quiet) args.push("-q");
  if (options.detach) args.push("--detach");
  if (options.branch) args.push(options.branch.flag, options.branch.name);
  args.push(dest);
  if (options.startPoint) args.push(options.startPoint);
  const added = await executeFile("git", args, { cwd: options.gitRoot, timeoutMs: 60_000 });
  let cloned = false;
  try {
    await cloneTree(options.gitRoot, dest, CLONE_SKIP_PREFIXES);
    cloned = true;
  } catch (error) {
    cloned = false;
    if (!(error instanceof CowUnavailableError) && !(error instanceof Error)) throw error;
  }
  await executeFile("git", ["reset", "--hard", "HEAD"], { cwd: dest, timeoutMs: 60_000 });
  await executeFile("git", ["clean", "-fd"], { cwd: dest, timeoutMs: 60_000 });
  return { cloned, message: added.stdout.trim() };
};
