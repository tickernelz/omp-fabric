import fs from "node:fs";
import path from "node:path";

// Freshness checks give served speculation results an at-serve-time guarantee
// beyond the mutation epoch: the stored promise resolves from state the world
// was in at launch, and the checker confirms that state still holds. Every
// checker is conservative — any doubt returns false and the call re-executes.
export type FabricFreshnessChecker = () => boolean;

interface FileSignature {
  mtimeMs: number;
  size: number;
}

const statSignature = (filePath: string): FileSignature | "missing" | "error" => {
  try {
    const stats = fs.statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error";
  }
};

const signatureEquals = (left: FileSignature | "missing", right: FileSignature | "missing"): boolean =>
  left === "missing" || right === "missing"
    ? left === right
    : left.mtimeMs === right.mtimeMs && left.size === right.size;

const readFreshness = (
  args: Record<string, unknown>,
  cwd: string,
): FabricFreshnessChecker | undefined => {
  const target = args.path;
  if (typeof target !== "string" || target.length === 0) return undefined;
  const resolved = path.resolve(cwd, target);
  const snapshot = statSignature(resolved);
  if (snapshot === "error") return undefined;
  return () => {
    const current = statSignature(resolved);
    return current !== "error" && signatureEquals(snapshot, current);
  };
};

/**
 * Build a serve-time freshness checker for a speculated call, or undefined
 * when the ref relies on epoch invalidation alone (tree-walking reads,
 * session-local stores). The epoch already covers every effect executed inside
 * the program; checkers exist for state that can move independently of the
 * program (the working tree) on refs where checking is O(1).
 */
export const createFreshnessChecker = (
  ref: string,
  preparedArgs: Record<string, unknown>,
  cwd: string,
): FabricFreshnessChecker | undefined => {
  if (ref === "omp.read") return readFreshness(preparedArgs, cwd);
  return undefined;
};
