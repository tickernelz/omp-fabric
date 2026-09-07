import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionsDir, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { readSessionHeader } from "./normalize.js";

export interface SessionRef {
  id: string;
  file: string;
  cwd: string;
  mtime: number;
}

export interface ResolveScopeInput {
  agentDir: string;
  cwd: string;
  scope: string;
  sessionId?: string;
  sessionFile?: string;
  maxSessions: number;
}

const SESSION_SCOPE_PREFIX = "session:";
const PROJECT_SCOPE_PREFIX = "project:";

/** Project scope matched no session directory at all, so its emptiness is unverified. */
export const PROJECT_SESSION_DIR_MISSING = "project_session_dir_missing";

const isJsonlFile = (name: string): boolean => name.endsWith(".jsonl");

type SessionDirScope = "home" | "tmp" | "abs";

const isWithinRoot = (relative: string): boolean =>
  relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

const encodeRelativeDirName = (prefix: string, relative: string): string => {
  const encoded = relative.replace(/[/\\:]/g, "-");
  if (!encoded) return prefix;
  return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
};

const encodeAbsoluteDirName = (absolute: string): string =>
  `--${absolute.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const encodeHashedDirName = (canonicalCwd: string, scope: SessionDirScope): string => {
  const readable = path
    .basename(canonicalCwd)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
  const digest = crypto
    .createHash("sha256")
    .update(canonicalCwd.replaceAll("\\", "/"))
    .digest("hex");
  return `${scope}-${readable || "project"}-${digest}`;
};

/** OMP's session directory names for a cwd: the one it writes today plus superseded encodings. */
export const sessionDirNamesForCwd = (cwd: string): { canonical: string; legacy: string[] } => {
  const resolved = path.resolve(cwd);
  const canonicalCwd = resolveEquivalentPath(resolved);
  const homeRelative = path.relative(resolveEquivalentPath(os.homedir()), canonicalCwd);
  const tempRelative = path.relative(resolveEquivalentPath(os.tmpdir()), canonicalCwd);
  let canonical: string;
  let scope: SessionDirScope;
  if (isWithinRoot(homeRelative)) {
    canonical = encodeRelativeDirName("-", homeRelative);
    scope = "home";
  } else if (isWithinRoot(tempRelative)) {
    canonical = encodeRelativeDirName("-tmp", tempRelative);
    scope = "tmp";
  } else {
    canonical = encodeAbsoluteDirName(canonicalCwd);
    scope = "abs";
  }
  const legacy: string[] = [];
  for (
    const name of [
      encodeAbsoluteDirName(canonicalCwd),
      encodeAbsoluteDirName(resolved),
      encodeHashedDirName(canonicalCwd, scope),
    ]
  ) {
    if (name !== canonical && !legacy.includes(name)) legacy.push(name);
  }
  return { canonical, legacy };
};

const listJsonlInDir = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isJsonlFile(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

const statMtime = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const refFromFile = (file: string): SessionRef => {
  const header = readSessionHeader(file);
  return {
    id: header?.sessionId ?? path.basename(file, ".jsonl"),
    file,
    cwd: header?.cwd ?? "",
    mtime: statMtime(file),
  };
};

export const sessionsDirRoot = (agentDir: string): string => getSessionsDir(agentDir);

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/** Existing session directories that hold this cwd's sessions, current encoding first. */
export const sessionDirsForCwd = (cwd: string, agentDir: string): string[] => {
  const root = sessionsDirRoot(agentDir);
  const names = sessionDirNamesForCwd(cwd);
  const dirs: string[] = [];
  for (const name of [names.canonical, ...names.legacy]) {
    const dir = path.join(root, name);
    if (isDirectory(dir)) dirs.push(dir);
  }
  return dirs;
};

const compareRefsByRecency = (left: SessionRef, right: SessionRef): number => {
  if (right.mtime !== left.mtime) return right.mtime - left.mtime;
  return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
};

/** Directory holding the running session's file when it sits outside the agent dir. */
export const overrideSessionDir = (sessionFile: string | undefined): string | undefined => {
  if (!sessionFile) return undefined;
  const dir = path.dirname(path.resolve(sessionFile));
  return isDirectory(dir) ? dir : undefined;
};

/**
 * Every session JSONL file under the agent dir plus the session dir in use, newest first by
 * file mtime, deduplicated by path and bounded by `maxSessions`.
 */
export const enumerateAllSessions = (
  agentDir: string,
  maxSessions: number,
  sessionDir?: string,
): SessionRef[] => {
  const files = new Set<string>();
  const root = sessionsDirRoot(agentDir);
  try {
    for (
      const entry of fs.readdirSync(root, { withFileTypes: true }).filter((candidate) =>
        candidate.isDirectory()
      )
    ) {
      for (const file of listJsonlInDir(path.join(root, entry.name))) files.add(file);
    }
  } catch {}
  if (sessionDir !== undefined) {
    for (const file of listJsonlInDir(sessionDir)) files.add(file);
  }
  return [...files]
    .map(refFromFile)
    .sort(compareRefsByRecency)
    .slice(0, Math.max(1, maxSessions));
};

export class AmbiguousSessionError extends Error {
  readonly code = "ambiguous_session";

  constructor(
    readonly session: string,
    readonly candidates: string[],
  ) {
    super(`Session id ${JSON.stringify(session)} is ambiguous; use an exact session file path.`);
    this.name = "AmbiguousSessionError";
  }
}

export const resolveSessionTarget = (
  agentDir: string,
  target: string,
  sessionDir?: string,
): SessionRef | null => {
  if (target.endsWith(".jsonl") && fs.existsSync(target)) {
    return refFromFile(path.resolve(target));
  }
  const all = enumerateAllSessions(agentDir, Number.MAX_SAFE_INTEGER, sessionDir);
  const byId = all.filter((ref) => ref.id === target);
  if (byId.length > 1) throw new AmbiguousSessionError(target, byId.map((ref) => ref.file));
  if (byId.length === 1) return byId[0]!;
  const byStem = all.filter((ref) => path.basename(ref.file, ".jsonl") === target);
  if (byStem.length > 1) throw new AmbiguousSessionError(target, byStem.map((ref) => ref.file));
  return byStem[0] ?? null;
};

export interface ScopeResolution {
  refs: SessionRef[];
  reasons: string[];
  candidateDirs: string[];
  searchedDirs: string[];
}

const sameProjectCwd = (candidate: string, cwd: string): boolean =>
  candidate.length > 0 && resolveEquivalentPath(candidate) === resolveEquivalentPath(cwd);

export class InvalidProjectScopeError extends Error {
  readonly code = "invalid_project_scope";

  constructor(
    readonly project: string,
    readonly projectPath: string,
    readonly reason: "missing" | "not_a_directory",
  ) {
    super(
      reason === "missing"
        ? `Project scope path ${JSON.stringify(projectPath)} does not exist.`
        : `Project scope path ${JSON.stringify(projectPath)} is not a directory.`,
    );
    this.name = "InvalidProjectScopeError";
  }
}

const resolveProjectScopeTarget = (target: string, cwd: string): string => {
  const resolved = path.resolve(cwd, target);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new InvalidProjectScopeError(target, resolved, "missing");
  }
  if (!stats.isDirectory()) {
    throw new InvalidProjectScopeError(target, resolved, "not_a_directory");
  }
  return resolved;
};

const projectSessions = (
  input: ResolveScopeInput,
  projectCwd: string,
): { refs: SessionRef[]; candidateDirs: string[]; searchedDirs: string[] } => {
  const root = sessionsDirRoot(input.agentDir);
  const names = sessionDirNamesForCwd(projectCwd);
  const candidateDirs = [names.canonical, ...names.legacy].map((name) => path.join(root, name));
  const searchedDirs = candidateDirs.filter(isDirectory);
  const refs: SessionRef[] = [];
  const seen = new Set<string>();
  for (const dir of searchedDirs) {
    for (const file of listJsonlInDir(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      refs.push(refFromFile(file));
    }
  }
  const override = overrideSessionDir(input.sessionFile);
  if (override !== undefined && !searchedDirs.includes(override)) {
    candidateDirs.push(override);
    searchedDirs.push(override);
    for (const file of listJsonlInDir(override)) {
      if (seen.has(file)) continue;
      const ref = refFromFile(file);
      if (!sameProjectCwd(ref.cwd, projectCwd)) continue;
      seen.add(file);
      refs.push(ref);
    }
  }
  refs.sort(compareRefsByRecency);
  return { refs, candidateDirs, searchedDirs };
};

/**
 * Resolve a scope string into the session files to search plus why the set may be short.
 *
 * - `session` (default): the invoking session file, else the newest session for this cwd.
 * - `project`: every session OMP stored for this cwd, across current and superseded dir names.
 * - `project:<path>`: the same, for another project directory; relative paths resolve against
 *   `cwd`, and an empty suffix means this cwd. Throws `InvalidProjectScopeError` when the path
 *   is missing or is not a directory.
 * - `global`: all sessions under the agent dir, bounded by `maxSessions`.
 * - `session:<id-or-path>`: one specific session by id or file path.
 *
 * Project scope reports `PROJECT_SESSION_DIR_MISSING` when no candidate directory exists, so a
 * caller can tell an unresolvable scope from a searched-but-empty corpus.
 */
export const resolveScope = (input: ResolveScopeInput): ScopeResolution => {
  const scope = input.scope?.trim() ?? "";
  const sessionDir = overrideSessionDir(input.sessionFile);
  if (scope.startsWith(SESSION_SCOPE_PREFIX)) {
    const target = scope.slice(SESSION_SCOPE_PREFIX.length).trim();
    const ref = resolveSessionTarget(input.agentDir, target, sessionDir);
    return { refs: ref ? [ref] : [], reasons: [], candidateDirs: [], searchedDirs: [] };
  }
  if (scope === "global") {
    const root = sessionsDirRoot(input.agentDir);
    const roots = [root, ...(sessionDir !== undefined && sessionDir !== root ? [sessionDir] : [])];
    return {
      refs: enumerateAllSessions(input.agentDir, input.maxSessions, sessionDir),
      reasons: [],
      candidateDirs: roots,
      searchedDirs: roots.filter(isDirectory),
    };
  }
  if (scope === "project" || scope.startsWith(PROJECT_SCOPE_PREFIX)) {
    const target = scope.startsWith(PROJECT_SCOPE_PREFIX)
      ? scope.slice(PROJECT_SCOPE_PREFIX.length).trim()
      : "";
    const projectCwd = target === "" ? input.cwd : resolveProjectScopeTarget(target, input.cwd);
    const found = projectSessions(input, projectCwd);
    return {
      refs: found.refs.slice(0, Math.max(1, input.maxSessions)),
      reasons: found.searchedDirs.length === 0 ? [PROJECT_SESSION_DIR_MISSING] : [],
      candidateDirs: found.candidateDirs,
      searchedDirs: found.searchedDirs,
    };
  }
  if (input.sessionFile) {
    return {
      refs: [refFromFile(input.sessionFile)],
      reasons: [],
      candidateDirs: [],
      searchedDirs: [],
    };
  }
  const found = projectSessions(input, input.cwd);
  const newest = found.refs[0];
  return {
    refs: newest ? [newest] : [],
    reasons: found.searchedDirs.length === 0 ? [PROJECT_SESSION_DIR_MISSING] : [],
    candidateDirs: found.candidateDirs,
    searchedDirs: found.searchedDirs,
  };
};
