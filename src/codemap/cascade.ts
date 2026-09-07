import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CoChangeEdge, CoChangeGraph, CoChangeRequest } from "./types.js";

const execFileAsync = promisify(execFile);

const BULK_COMMIT_FILE_CEILING = 100;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 64 << 20;
const COMMIT_MARKER_CODE = 1;
const QUOTE_CODE = 34;

const ESCAPE_BYTES = new Map<string, number>([
  ["a", 7],
  ["b", 8],
  ["t", 9],
  ["n", 10],
  ["v", 11],
  ["f", 12],
  ["r", 13],
  ['"', 34],
  ["\\", 92],
]);

const toPosix = (value: string): string => (path.sep === "/" ? value : value.replaceAll(path.sep, "/"));

const unquoteGitPath = (raw: string): string => {
  if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== QUOTE_CODE) return raw;
  const bytes: number[] = [];
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index] as string;
    if (char !== "\\") {
      const code = char.charCodeAt(0);
      if (code < 0x80) bytes.push(code);
      else for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) break;
    const mapped = ESCAPE_BYTES.get(next);
    if (mapped !== undefined) {
      bytes.push(mapped);
      index += 1;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let value = 0;
      let digits = 0;
      while (digits < 3) {
        const digit = raw[index + 1 + digits];
        if (digit === undefined || digit < "0" || digit > "7") break;
        value = value * 8 + (digit.charCodeAt(0) - 48);
        digits += 1;
      }
      bytes.push(value & 0xff);
      index += digits;
      continue;
    }
    bytes.push(next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
};

const realPath = (value: string): string => {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
};

const relativeSeed = (root: string, top: string, seed: string): string | undefined => {
  const absolute = path.isAbsolute(seed) ? seed : path.resolve(root, seed);
  for (const base of new Set([top, realPath(top)])) {
    for (const candidate of new Set([absolute, realPath(absolute), path.resolve(realPath(root), seed)])) {
      const relative = path.relative(base, candidate);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        continue;
      }
      return toPosix(relative);
    }
  }
  return undefined;
};

const emptyGraph = (seeds: string[], unavailable: string): CoChangeGraph => ({
  seeds,
  edges: [],
  commitsScanned: 0,
  truncated: false,
  unavailable,
});

export async function coChange(request: CoChangeRequest): Promise<CoChangeGraph> {
  const requestedSeeds = request.seeds.filter((seed) => seed.length > 0);
  if (requestedSeeds.length === 0) return emptyGraph([], "no seed files were provided");
  if (!existsSync(request.root)) return emptyGraph(requestedSeeds, "root directory does not exist");

  const maxCommits = Math.max(1, Math.floor(request.maxCommits) || 1);
  const limit = Math.max(1, Math.floor(request.limit) || 1);

  let top: string;
  try {
    const revParse = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: request.root,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
    });
    top = revParse.stdout.trim();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return emptyGraph(requestedSeeds, "git is not available");
    return emptyGraph(requestedSeeds, "not a git repository");
  }
  if (!top) return emptyGraph(requestedSeeds, "not a git repository");

  const seedSet = new Set<string>();
  for (const seed of requestedSeeds) {
    const normalized = relativeSeed(request.root, top, seed);
    if (normalized) seedSet.add(normalized);
  }
  const seeds = [...seedSet];
  if (seeds.length === 0) return emptyGraph(requestedSeeds, "seed files are outside the repository");

  let stdout: string;
  try {
    const log = await execFileAsync(
      "git",
      [
        "log",
        `--max-count=${maxCommits}`,
        "--no-merges",
        "--name-only",
        `--pretty=format:\u0001%H`,
      ],
      {
        cwd: top,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
      },
    );
    stdout = log.stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return emptyGraph(seeds, "commit history exceeded the read budget");
    }
    return emptyGraph(seeds, "no commit history");
  }

  const fileCommits = new Map<string, number>();
  const sharedCommits = new Map<string, number>();
  const current: string[] = [];
  let commitsScanned = 0;
  let seedCommits = 0;
  let inCommit = false;
  let bulk = false;

  const settle = (): void => {
    if (!inCommit) return;
    inCommit = false;
    if (bulk) {
      bulk = false;
      current.length = 0;
      return;
    }
    commitsScanned += 1;
    let touchesSeed = false;
    for (const file of current) {
      if (seedSet.has(file)) {
        touchesSeed = true;
        break;
      }
    }
    if (touchesSeed) seedCommits += 1;
    for (const file of current) {
      fileCommits.set(file, (fileCommits.get(file) ?? 0) + 1);
      if (touchesSeed && !seedSet.has(file)) {
        sharedCommits.set(file, (sharedCommits.get(file) ?? 0) + 1);
      }
    }
    current.length = 0;
  };

  let cursor = 0;
  while (cursor <= stdout.length) {
    let end = stdout.indexOf("\n", cursor);
    if (end < 0) end = stdout.length;
    const line = stdout.slice(cursor, end);
    cursor = end + 1;
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === COMMIT_MARKER_CODE) {
      settle();
      inCommit = true;
      continue;
    }
    if (!inCommit || bulk) continue;
    if (current.length >= BULK_COMMIT_FILE_CEILING) {
      bulk = true;
      current.length = 0;
      continue;
    }
    current.push(line.charCodeAt(0) === QUOTE_CODE ? unquoteGitPath(line) : line);
  }
  settle();

  if (commitsScanned === 0) return emptyGraph(seeds, "no commit history");

  const edges: CoChangeEdge[] = [];
  if (seedCommits > 0) {
    const seedRoot = Math.sqrt(seedCommits);
    for (const [file, shared] of sharedCommits) {
      const total = fileCommits.get(file) ?? shared;
      edges.push({ file, score: shared / (seedRoot * Math.sqrt(total)), commits: shared });
    }
  }
  edges.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.commits !== left.commits) return right.commits - left.commits;
    return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
  });

  const truncated = edges.length > limit;
  if (truncated) edges.length = limit;

  if (seedCommits === 0) {
    return { seeds, edges, commitsScanned, truncated, unavailable: "seed files do not appear in the scanned history" };
  }
  return { seeds, edges, commitsScanned, truncated };
}
