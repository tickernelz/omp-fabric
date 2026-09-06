import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import {
  PROJECT_SESSION_DIR_MISSING,
  resolveScope,
  sessionDirNamesForCwd,
} from "../src/memory/discovery.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { messageEntry, sessionHeader, userMessage, writeSessionFile } from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `omp-fabric-scope-${name}-`));
  temporaryDirectories.push(directory);
  return fs.realpathSync(directory);
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const invocation = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-scope",
  nestedToolCallId: "memory-scope-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const memoryConfig = (indexDir: string): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 20_000,
  indexThinking: false,
  indexToolOutput: true,
  hotSessions: 50,
});

const message = (id: string, text: string) =>
  messageEntry(id, null, "2024-12-03T14:00:01.000Z", userMessage(text));

const supersededName = (cwd: string): string =>
  `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const tempSegment = (dir: string): string => {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), dir);
  expect(relative.includes(path.sep)).toBe(false);
  return relative;
};

describe("project session directory naming", () => {
  it("names the home root exactly as OMP does", () => {
    expect(sessionDirNamesForCwd(os.homedir()).canonical).toBe("-");
  });

  it("names a temp-rooted project with the -tmp prefix, keeping dots and spaces", () => {
    const project = path.join(fs.realpathSync(os.tmpdir()), "omp fabric. scope-probe");
    fs.mkdirSync(project, { recursive: true });
    temporaryDirectories.push(project);
    expect(sessionDirNamesForCwd(`${project}${path.sep}`).canonical)
      .toBe("-tmp-omp fabric. scope-probe");
  });

  it("joins nested segments with dashes", () => {
    const root = temporaryDirectory("nested");
    const nested = path.join(root, "inner", "leaf");
    fs.mkdirSync(nested, { recursive: true });
    expect(sessionDirNamesForCwd(nested).canonical)
      .toBe(`-tmp-${tempSegment(root)}-inner-leaf`);
  });

  it("keeps the wrapped absolute form only for paths outside home and tmp", () => {
    const outside = path.resolve(path.sep, "srv", "checkout", "project");
    expect(sessionDirNamesForCwd(outside).canonical).toBe("--srv-checkout-project--");
  });

  it("never returns the superseded wrapped form for a temp project", () => {
    const project = temporaryDirectory("negative-control");
    expect(sessionDirNamesForCwd(project).canonical).not.toBe(supersededName(project));
    expect(sessionDirNamesForCwd(project).legacy).toContain(supersededName(project));
  });
});

describe("project scope discovery", () => {
  it("finds the session in the directory OMP actually writes", () => {
    const agentDir = temporaryDirectory("agent-current");
    const project = temporaryDirectory("current");
    const root = path.join(agentDir, "sessions");
    const written = writeSessionFile(path.join(root, `-tmp-${tempSegment(project)}`), "live.jsonl", [
      sessionHeader("live-session", project),
      message("one", "PROJECT_SCOPE_TOKEN_A"),
    ]);

    expect(fs.existsSync(path.join(root, supersededName(project)))).toBe(false);

    const resolution = resolveScope({
      agentDir,
      cwd: project,
      scope: "project",
      maxSessions: 500,
    });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([written]);
    expect(resolution.reasons).toEqual([]);
  });

  it("still finds sessions left under a superseded directory encoding", () => {
    const agentDir = temporaryDirectory("agent-legacy");
    const project = temporaryDirectory("legacy");
    const written = writeSessionFile(
      path.join(agentDir, "sessions", supersededName(project)),
      "old.jsonl",
      [sessionHeader("legacy-session", project), message("one", "PROJECT_SCOPE_TOKEN_B")],
    );

    const resolution = resolveScope({
      agentDir,
      cwd: project,
      scope: "project",
      maxSessions: 500,
    });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([written]);
    expect(resolution.reasons).toEqual([]);
  });

  it("merges current and superseded directories without duplicating sessions", () => {
    const agentDir = temporaryDirectory("agent-merge");
    const project = temporaryDirectory("merge");
    const root = path.join(agentDir, "sessions");
    const current = writeSessionFile(path.join(root, `-tmp-${tempSegment(project)}`), "new.jsonl", [
      sessionHeader("new-session", project),
      message("one", "PROJECT_SCOPE_TOKEN_C"),
    ]);
    const legacy = writeSessionFile(path.join(root, supersededName(project)), "old.jsonl", [
      sessionHeader("old-session", project),
      message("one", "PROJECT_SCOPE_TOKEN_C"),
    ]);

    const resolution = resolveScope({
      agentDir,
      cwd: project,
      scope: "project",
      maxSessions: 500,
    });
    expect(resolution.refs.map((ref) => ref.file).sort()).toEqual([current, legacy].sort());
  });

  it("reads a session-dir override only for sessions whose cwd matches", () => {
    const agentDir = temporaryDirectory("agent-override");
    const project = temporaryDirectory("override");
    const other = temporaryDirectory("override-other");
    const overrideDir = temporaryDirectory("override-store");
    const mine = writeSessionFile(overrideDir, "mine.jsonl", [
      sessionHeader("override-session", project),
      message("one", "PROJECT_SCOPE_TOKEN_D"),
    ]);
    writeSessionFile(overrideDir, "theirs.jsonl", [
      sessionHeader("foreign-session", other),
      message("one", "PROJECT_SCOPE_TOKEN_D"),
    ]);

    const resolution = resolveScope({
      agentDir,
      cwd: project,
      scope: "project",
      sessionFile: mine,
      maxSessions: 500,
    });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([mine]);
    expect(resolution.searchedDirs).toContain(overrideDir);
  });

  it("reaches a session-dir store for global and session:<id> without widening project scope", () => {
    const agentDir = temporaryDirectory("agent-session-dir");
    const project = temporaryDirectory("session-dir-project");
    const other = temporaryDirectory("session-dir-other");
    const overrideDir = temporaryDirectory("session-dir-store");
    const mine = writeSessionFile(overrideDir, "mine.jsonl", [
      sessionHeader("outside-session", project),
      message("one", "PROJECT_SCOPE_TOKEN_G"),
    ]);
    const theirs = writeSessionFile(overrideDir, "theirs.jsonl", [
      sessionHeader("outside-foreign", other),
      message("one", "PROJECT_SCOPE_TOKEN_G"),
    ]);
    const input = { agentDir, cwd: project, sessionFile: mine, maxSessions: 500 };

    const global = resolveScope({ ...input, scope: "global" });
    expect(global.refs.map((ref) => ref.file).sort()).toEqual([mine, theirs].sort());
    expect(global.searchedDirs).toContain(overrideDir);

    const byId = resolveScope({ ...input, scope: "session:outside-foreign" });
    expect(byId.refs.map((ref) => ref.file)).toEqual([theirs]);

    const scoped = resolveScope({ ...input, scope: "project" });
    expect(scoped.refs.map((ref) => ref.file)).toEqual([mine]);
  });

  it("counts a session-dir store once when it is already the project directory", () => {
    const agentDir = temporaryDirectory("agent-same-dir");
    const project = temporaryDirectory("same-dir");
    const canonical = path.join(agentDir, "sessions", `-tmp-${tempSegment(project)}`);
    const written = writeSessionFile(canonical, "live.jsonl", [
      sessionHeader("same-dir-session", project),
      message("one", "PROJECT_SCOPE_TOKEN_H"),
    ]);
    const input = { agentDir, cwd: project, sessionFile: written, maxSessions: 500 };

    expect(resolveScope({ ...input, scope: "project" }).refs.map((ref) => ref.file))
      .toEqual([written]);
    expect(resolveScope({ ...input, scope: "project" }).searchedDirs).toEqual([canonical]);
    expect(resolveScope({ ...input, scope: "global" }).refs.map((ref) => ref.file))
      .toEqual([written]);
  });

  it("separates an unresolvable scope from a searched but empty corpus", () => {
    const agentDir = temporaryDirectory("agent-empty");
    const project = temporaryDirectory("empty");
    const missing = resolveScope({ agentDir, cwd: project, scope: "project", maxSessions: 500 });
    expect(missing.refs).toEqual([]);
    expect(missing.reasons).toEqual([PROJECT_SESSION_DIR_MISSING]);
    expect(missing.searchedDirs).toEqual([]);
    expect(missing.candidateDirs[0]).toBe(
      path.join(agentDir, "sessions", `-tmp-${tempSegment(project)}`),
    );

    fs.mkdirSync(missing.candidateDirs[0]!, { recursive: true });
    const empty = resolveScope({ agentDir, cwd: project, scope: "project", maxSessions: 500 });
    expect(empty.refs).toEqual([]);
    expect(empty.reasons).toEqual([]);
    expect(empty.searchedDirs).toEqual([missing.candidateDirs[0]]);
  });
});

describe("memory provider project scope signalling", () => {
  it("marks recall incomplete and names the missing directory on sessions", async () => {
    const agentDir = temporaryDirectory("provider-agent");
    const indexDir = temporaryDirectory("provider-index");
    const project = temporaryDirectory("provider-project");
    const provider = new MemoryProvider({ agentDir, cwd: project, config: memoryConfig(indexDir) });

    const recall = await provider.invoke(
      "recall",
      { scope: "project", query: "PROJECT_SCOPE_TOKEN_E" },
      invocation(project),
    ) as { total: number; coverage: { complete: boolean; reasons: string[] } };
    expect(recall.total).toBe(0);
    expect(recall.coverage.complete).toBe(false);
    expect(recall.coverage.reasons).toContain(PROJECT_SESSION_DIR_MISSING);

    const sessions = await provider.invoke(
      "sessions",
      { scope: "project" },
      invocation(project),
    ) as { sessions: unknown[]; error?: { code: string; candidateDirectories: string[] } };
    expect(sessions.sessions).toEqual([]);
    expect(sessions.error?.code).toBe(PROJECT_SESSION_DIR_MISSING);
    expect(sessions.error?.candidateDirectories).toContain(
      path.join(agentDir, "sessions", `-tmp-${tempSegment(project)}`),
    );
  });

  it("reports a complete search once the project directory exists", async () => {
    const agentDir = temporaryDirectory("provider-hit-agent");
    const indexDir = temporaryDirectory("provider-hit-index");
    const project = temporaryDirectory("provider-hit");
    writeSessionFile(
      path.join(agentDir, "sessions", `-tmp-${tempSegment(project)}`),
      "live.jsonl",
      [sessionHeader("hit-session", project), message("one", "PROJECT_SCOPE_TOKEN_F")],
    );
    const provider = new MemoryProvider({ agentDir, cwd: project, config: memoryConfig(indexDir) });

    const recall = await provider.invoke(
      "recall",
      { scope: "project", query: "PROJECT_SCOPE_TOKEN_F" },
      invocation(project),
    ) as {
      total: number;
      coverage: { complete: boolean; eligibleSessions: number; reasons: string[] };
    };
    expect(recall.total).toBe(1);
    expect(recall.coverage.eligibleSessions).toBe(1);
    expect(recall.coverage.complete).toBe(true);
    expect(recall.coverage.reasons).toEqual([]);

    const sessions = await provider.invoke(
      "sessions",
      { scope: "project" },
      invocation(project),
    ) as { sessions: Array<{ id: string }>; error?: unknown };
    expect(sessions.sessions.map((entry) => entry.id)).toEqual(["hit-session"]);
    expect(sessions.error).toBeUndefined();
  });
});
