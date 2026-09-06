import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Prewalk's audit claim never sees writes made through opaque OMP shell calls
// heredocs, sed -i, formatter binaries — because audits record tool refs, not
// file effects. While a session is armed, a bash-running boundary without an
// audited mutation diffs the work tree against a per-session stat baseline
// (size + mtimeMs per file, fovea-style); drift becomes a filesystem trigger
// for the same claim pipeline. Baselines stay read-free; stat drift is
// content-verified at evaluation time instead (fovea's capture/finish habit,
// adapted): the first stat-drift window records each modified file's SHA-1,
// and a later window whose content hash matches the recorded one is mtime-only
// churn — formatter rewrites, touch — filtered out of the report. First
// sightings still claim: at most one misfire per file per content state.
//
// Listing is git-index-backed when possible because `git ls-files -co
// --exclude-standard` already honors every ignore layer, so build output in
// ignored directories never registers as drift. Git-less trees fall back to
// an in-process walk skipping only .git and node_modules, where artifact
// writes do count as drift — the honest but noisier signal.

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_TRACKED_FILES = 200_000;
const MAX_REPORT_FILES = 100;
const GIT_TIMEOUT_MS = 10_000;
const STAT_CONCURRENCY = 32;
// Content-verification budget: hash at most this many stat-modified files per
// evaluation, and never a file larger than HASH_MAX_BYTES. Over-budget files
// stay in the report unrecorded, failing open toward claiming.
const MAX_HASH_FILES_PER_EVAL = 256;
const HASH_MAX_BYTES = 16 << 20;
const WALK_SKIP_DIRS = new Set([".git", "node_modules"]);

interface FileStat {
  size: number;
  mtimeMs: number;
  // Content SHA-1 recorded when a stat-drift window last hashed this file;
  // used to filter later mtime-only churn. Absent until first drift.
  sha1?: string;
}

interface DriftSnapshot {
  // Listing root: the git work-tree top when the session cwd sits inside a
  // repo, otherwise the cwd itself. Paths in `files` are relative to it.
  root: string;
  files: Map<string, FileStat>;
  overflow: boolean;
}

export interface PrewalkFsDrift {
  files: string[];
  truncated: number;
  added: number;
  modified: number;
  deleted: number;
  // Stat-modified files excluded from the report because their content hash
  // still matches the last recorded state (mtime-only churn).
  unchanged: number;
}

const listGitFiles = async (
  cwd: string,
): Promise<{ root: string; files: string[] } | undefined> => {
  try {
    const top = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
    });
    const root = top.stdout.trim();
    if (!root) return undefined;
    const listed = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 << 20 },
    );
    return { root, files: listed.stdout.split("\0").filter((file) => file.length > 0) };
  } catch {
    return undefined;
  }
};

const listWalkFiles = async (
  root: string,
  maxTrackedFiles: number,
): Promise<{ files: string[]; overflow: boolean }> => {
  const files: string[] = [];
  const pendingDirs = [root];
  let rootListed = false;
  while (pendingDirs.length > 0) {
    const dir = pendingDirs.pop();
    if (!dir) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      rootListed = true;
    } catch {
      // Root listing failures must not masquerade as "everything is still
      // there" or, inverted, survive as an empty manifest; propagate them so
      // the caller can skip this window. Nested failures are ordinary churn.
      if (!rootListed && dir === root) throw new Error(`Prewalk drift cannot list ${root}`);
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) pendingDirs.push(absolute);
        continue;
      }
      // Symlinks, sockets, and fifos are never tracked: no link cycles, no
      // special-file stats. Symlinked file edits surface through the target
      // only when the target itself is inside the listing root.
      if (!entry.isFile()) continue;
      files.push(path.relative(root, absolute));
      if (files.length > maxTrackedFiles) return { files, overflow: true };
    }
  }
  return { files, overflow: false };
};

const statManifest = async (
  root: string,
  files: string[],
): Promise<Map<string, FileStat>> => {
  const manifest = new Map<string, FileStat>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const relative = files[cursor];
      cursor += 1;
      if (!relative) continue;
      try {
        const entry = await stat(path.join(root, relative));
        if (entry.isFile()) manifest.set(relative, { size: entry.size, mtimeMs: entry.mtimeMs });
      } catch {
        // Vanished mid-scan: plain churn, resolved by the next diff.
      }
    }
  };
  await Promise.all(Array.from({ length: STAT_CONCURRENCY }, () => worker()));
  return manifest;
};

export class PrewalkDriftTracker {
  readonly #maxTrackedFiles: number;
  readonly #baselines = new Map<string, DriftSnapshot>();

  constructor(options?: { maxTrackedFiles?: number }) {
    this.#maxTrackedFiles =
      options?.maxTrackedFiles && options.maxTrackedFiles > 0
        ? Math.floor(options.maxTrackedFiles)
        : DEFAULT_MAX_TRACKED_FILES;
  }

  // Best-effort: an unreadable tree leaves the session baseline-less, which
  // fail-opens to "never claim" rather than firing on a partial picture.
  async captureBaseline(sessionId: string, cwd: string): Promise<void> {
    try {
      this.#baselines.set(sessionId, await this.#snapshot(cwd));
    } catch {
      this.#baselines.delete(sessionId);
    }
  }

  // Diff the current tree against the session baseline. Every successful
  // evaluation advances the baseline — claimed or not — so consecutive runs
  // never re-fire on the same filesystem state.
  async evaluate(sessionId: string, cwd: string): Promise<PrewalkFsDrift | undefined> {
    const baseline = this.#baselines.get(sessionId);
    let current: DriftSnapshot;
    try {
      current = await this.#snapshot(cwd);
    } catch {
      return undefined; // Keep the previous baseline; retry at the next boundary.
    }
    const rebaseline = (): undefined => {
      this.#baselines.set(sessionId, current);
      return undefined;
    };
    if (!baseline || baseline.root !== current.root) return rebaseline();
    if (baseline.overflow || current.overflow) return rebaseline();
    // An empty current manifest against a populated baseline means the stat
    // pass collapsed wholesale (permissions, mid-scan teardown), not a real
    // "delete the world" event; re-anchor instead of firing a mass deletion.
    if (current.files.size === 0 && baseline.files.size > 0) return rebaseline();
    const files: string[] = [];
    let added = 0;
    let deleted = 0;
    // Stat-modified files are only candidates until content-verified.
    const candidates: Array<{ file: string; before: FileStat; entry: FileStat }> = [];
    for (const [file, now] of current.files) {
      const before = baseline.files.get(file);
      if (!before) {
        added += 1;
        files.push(file);
        continue;
      }
      if (before.size !== now.size || Math.abs(before.mtimeMs - now.mtimeMs) > 1e-6) {
        candidates.push({ file, before, entry: now });
      }
    }
    for (const file of baseline.files.keys()) {
      if (!current.files.has(file)) {
        deleted += 1;
        files.push(file);
      }
    }
    const verified = await this.#verifyModified(current.root, candidates);
    files.push(...verified.changed);
    this.#baselines.set(sessionId, current);
    if (files.length === 0) return undefined;
    const shown = files.slice(0, MAX_REPORT_FILES);
    return {
      files: shown,
      truncated: files.length - shown.length,
      added,
      modified: verified.changed.length,
      deleted,
      unchanged: verified.unchanged,
    };
  }

  // Content-verify stat-modified files against the last hash this tracker
  // recorded for them. The first stat-drift on a file teaches the fresh
  // baseline its SHA-1 while still reporting the change; a later window whose
  // recomputed hash matches the recorded one is mtime-only churn and leaves
  // the report. Files past the per-evaluation hash budget or the per-file
  // byte cap stay in the report unrecorded — baseline reads stay free and
  // unverifiable drift fails open toward claiming.
  async #verifyModified(
    root: string,
    candidates: Array<{ file: string; before: FileStat; entry: FileStat }>,
  ): Promise<{ changed: string[]; unchanged: number }> {
    const changed: string[] = [];
    let unchanged = 0;
    let hashBudget = MAX_HASH_FILES_PER_EVAL;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor];
        cursor += 1;
        if (!candidate) continue;
        const { file, before, entry } = candidate;
        if (hashBudget <= 0 || entry.size > HASH_MAX_BYTES || before.size > HASH_MAX_BYTES) {
          changed.push(file);
          continue;
        }
        hashBudget -= 1;
        let sha1: string;
        try {
          sha1 = createHash("sha1").update(await readFile(path.join(root, file))).digest("hex");
        } catch {
          // Vanished mid-window: fail open so churn is never silently swallowed.
          changed.push(file);
          continue;
        }
        entry.sha1 = sha1;
        if (before.sha1 === sha1) {
          unchanged += 1;
          continue;
        }
        changed.push(file);
      }
    };
    await Promise.all(Array.from({ length: STAT_CONCURRENCY }, () => worker()));
    return { changed, unchanged };
  }

  drop(sessionId: string): void {
    this.#baselines.delete(sessionId);
  }

  clear(): void {
    this.#baselines.clear();
  }

  async #snapshot(cwd: string): Promise<DriftSnapshot> {
    const root = path.resolve(cwd);
    const git = await listGitFiles(root);
    if (git) {
      const overflow = git.files.length > this.#maxTrackedFiles;
      const files = overflow
        ? new Map<string, FileStat>()
        : await statManifest(git.root, git.files);
      return { root: git.root, files, overflow };
    }
    const walked = await listWalkFiles(root, this.#maxTrackedFiles);
    const files = walked.overflow
      ? new Map<string, FileStat>()
      : await statManifest(root, walked.files);
    return { root, files, overflow: walked.overflow };
  }
}
