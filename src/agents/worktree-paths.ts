import fs from "node:fs";
import path from "node:path";
import { executeFile } from "./transports/process-utils.js";

const FABRIC_WORKTREE_SEGMENTS = [".omp", "fabric", "worktrees"] as const;
export const FABRIC_STATE_EXCLUDE = "**/.omp/fabric/";

export const fabricWorktreePath = (gitRoot: string, id: string): string =>
  path.join(gitRoot, ...FABRIC_WORKTREE_SEGMENTS, id);

export const isFabricWorktreePath = (worktree: string, id: string): boolean => {
  const parts = worktree.split(/[\\/]/).filter(Boolean);
  return (
    parts.length >= 4 &&
    parts.at(-1) === id &&
    parts.at(-2) === "worktrees" &&
    parts.at(-3) === "fabric" &&
    parts.at(-4) === ".omp"
  );
};

export const ensureFabricStateExclude = async (directory: string): Promise<void> => {
  const located = await executeFile("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: directory,
    timeoutMs: 10_000,
  });
  const excludePath = path.resolve(directory, located.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  let current = "";
  try {
    current = fs.readFileSync(excludePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  const lines = current.split(/\r?\n/);
  if (lines.some((line) => line.trim() === FABRIC_STATE_EXCLUDE)) return;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludePath, `${prefix}${FABRIC_STATE_EXCLUDE}\n`);
};
