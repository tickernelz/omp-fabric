#!/usr/bin/env node
// Runs only the vitest files affected by the current dirty working tree.
// Falls back to the full suite when git state is unreadable, so CI-like
// callers can always use this script safely.
import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

const tracked = (() => {
  try {
    return git(["diff", "HEAD", "--name-only"]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
})();
const untracked = (() => {
  try {
    return git(["ls-files", "--others", "--exclude-standard", "--", "src", "tests"])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
})();

if (tracked === null) {
  console.error("git unavailable; running the full suite");
  try {
    execFileSync("bun", ["--bun", "node_modules/vitest/vitest.mjs", "run"], { stdio: "inherit" });
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

const changed = [...new Set([...tracked, ...untracked])];
const srcFiles = changed.filter((f) => f.startsWith("src/"));
const testFiles = changed.filter((f) => f.startsWith("tests/"));

if (srcFiles.length === 0 && testFiles.length === 0) {
  console.log("no changed src/tests files; nothing to run");
  process.exit(0);
}

// vitest 4: `related` is a subcommand, not a `run` flag.
const runs = [];
if (srcFiles.length > 0) runs.push(["related", ...srcFiles]);
if (testFiles.length > 0) runs.push(["run", ...testFiles]);
console.log(runs.map((args) => "vitest " + args.join(" ")).join(" && "));
try {
  for (const args of runs) {
    execFileSync("bun", ["--bun", "node_modules/vitest/vitest.mjs", ...args], { stdio: "inherit" });
  }
} catch {
  process.exit(1);
}
