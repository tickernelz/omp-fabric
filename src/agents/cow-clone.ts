import fs from "node:fs";
import path from "node:path";

export const CLONE_SKIP_PREFIXES = [".git", ".omp/fabric/worktrees"] as const;

export class CowUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CowUnavailableError";
  }
}

const posixRel = (value: string): string => value.replaceAll("\\", "/");

const isCowUnavailable = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "ENOTSUPP";
};

const cloneEntry = async (from: string, to: string): Promise<void> => {
  try {
    await fs.promises.cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      mode: fs.constants.COPYFILE_FICLONE_FORCE,
    });
  } catch (error) {
    if (isCowUnavailable(error)) {
      throw new CowUnavailableError(`copy-on-write clone unavailable: ${from} -> ${to}`, {
        cause: error,
      });
    }
    throw error;
  }
};

const skipped = (rel: string, prefixes: readonly string[]): boolean => {
  const value = posixRel(rel);
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
};

const hasNestedSkip = (rel: string, prefixes: readonly string[]): boolean => {
  const value = posixRel(rel);
  return prefixes.some((prefix) => prefix.startsWith(`${value}/`));
};

const cloneLevel = async (
  source: string,
  dest: string,
  relBase: string,
  prefixes: readonly string[],
): Promise<void> => {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (skipped(rel, prefixes)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && hasNestedSkip(rel, prefixes)) {
      await cloneLevel(from, to, rel, prefixes);
      continue;
    }
    if (!(entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())) continue;
    await cloneEntry(from, to);
  }
};

export const cloneTree = async (
  source: string,
  dest: string,
  prefixes: readonly string[] = CLONE_SKIP_PREFIXES,
): Promise<void> => {
  await cloneLevel(source, dest, "", prefixes);
};
