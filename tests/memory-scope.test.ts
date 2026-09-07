import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidProjectScopeError,
  PROJECT_SESSION_DIR_MISSING,
  resolveScope,
} from "../src/memory/discovery.js";
import { messageEntry, sessionHeader, userMessage, writeSessionFile } from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `omp-fabric-project-scope-${name}-`));
  temporaryDirectories.push(directory);
  return fs.realpathSync(directory);
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const tempSegment = (dir: string): string => {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), dir);
  expect(relative.includes(path.sep)).toBe(false);
  return relative;
};

const message = (id: string, text: string) =>
  messageEntry(id, null, "2024-12-03T14:00:01.000Z", userMessage(text));

const writeProjectSession = (
  agentDir: string,
  project: string,
  dirName: string,
  sessionId: string,
  token: string,
): string =>
  writeSessionFile(path.join(agentDir, "sessions", dirName), `${sessionId}.jsonl`, [
    sessionHeader(sessionId, project),
    message("one", token),
  ]);

describe("project path scope", () => {
  it("reads the named project instead of the session cwd", () => {
    const agentDir = temporaryDirectory("agent-absolute");
    const here = temporaryDirectory("here");
    const there = temporaryDirectory("there");
    const hereFile = writeProjectSession(
      agentDir,
      here,
      `-tmp-${tempSegment(here)}`,
      "here-session",
      "SCOPE_TOKEN_HERE",
    );
    const thereFile = writeProjectSession(
      agentDir,
      there,
      `-tmp-${tempSegment(there)}`,
      "there-session",
      "SCOPE_TOKEN_THERE",
    );

    const resolution = resolveScope({
      agentDir,
      cwd: here,
      scope: `project:${there}`,
      maxSessions: 500,
    });

    expect(resolution.refs.map((ref) => ref.file)).toEqual([thereFile]);
    expect(resolution.refs.map((ref) => ref.file)).not.toContain(hereFile);
    expect(resolution.refs.map((ref) => ref.id)).toEqual(["there-session"]);
    expect(resolution.reasons).toEqual([]);
  });

  it("resolves a relative project path against the session cwd", () => {
    const agentDir = temporaryDirectory("agent-relative");
    const root = temporaryDirectory("relative-root");
    const alpha = path.join(root, "alpha");
    const beta = path.join(root, "beta");
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta);
    const betaFile = writeProjectSession(
      agentDir,
      beta,
      `-tmp-${tempSegment(root)}-beta`,
      "beta-session",
      "SCOPE_TOKEN_BETA",
    );

    const resolution = resolveScope({
      agentDir,
      cwd: alpha,
      scope: `project:${path.join("..", "beta")}`,
      maxSessions: 500,
    });

    expect(resolution.refs.map((ref) => ref.file)).toEqual([betaFile]);
  });

  it("reports an unsearchable project directory rather than an empty corpus", () => {
    const agentDir = temporaryDirectory("agent-unsearched");
    const here = temporaryDirectory("unsearched-here");
    const there = temporaryDirectory("unsearched-there");

    const resolution = resolveScope({
      agentDir,
      cwd: here,
      scope: `project:${there}`,
      maxSessions: 500,
    });

    expect(resolution.refs).toEqual([]);
    expect(resolution.reasons).toEqual([PROJECT_SESSION_DIR_MISSING]);
  });

  it("treats an empty suffix as the session cwd", () => {
    const agentDir = temporaryDirectory("agent-empty-suffix");
    const here = temporaryDirectory("empty-suffix");
    const hereFile = writeProjectSession(
      agentDir,
      here,
      `-tmp-${tempSegment(here)}`,
      "empty-suffix-session",
      "SCOPE_TOKEN_EMPTY",
    );

    expect(
      resolveScope({ agentDir, cwd: here, scope: "project:", maxSessions: 500 }).refs.map((ref) =>
        ref.file
      ),
    ).toEqual([hereFile]);
  });
});

describe("project path scope failures", () => {
  it("names a missing directory", () => {
    const agentDir = temporaryDirectory("agent-missing");
    const here = temporaryDirectory("missing-here");
    const absent = path.join(here, "no-such-project");

    let caught: unknown;
    try {
      resolveScope({ agentDir, cwd: here, scope: `project:${absent}`, maxSessions: 500 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidProjectScopeError);
    const failure = caught as InvalidProjectScopeError;
    expect(failure.code).toBe("invalid_project_scope");
    expect(failure.name).toBe("InvalidProjectScopeError");
    expect(failure.reason).toBe("missing");
    expect(failure.projectPath).toBe(absent);
    expect(failure.message).toBe(`Project scope path ${JSON.stringify(absent)} does not exist.`);
  });

  it("names a path that is a file rather than a directory", () => {
    const agentDir = temporaryDirectory("agent-file");
    const here = temporaryDirectory("file-here");
    const file = path.join(here, "notes.md");
    fs.writeFileSync(file, "not a project");

    let caught: unknown;
    try {
      resolveScope({ agentDir, cwd: here, scope: `project:${file}`, maxSessions: 500 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidProjectScopeError);
    const failure = caught as InvalidProjectScopeError;
    expect(failure.code).toBe("invalid_project_scope");
    expect(failure.reason).toBe("not_a_directory");
    expect(failure.message).toBe(`Project scope path ${JSON.stringify(file)} is not a directory.`);
  });

  it("keeps the written suffix separate from the path it expanded to", () => {
    const agentDir = temporaryDirectory("agent-relative-missing");
    const here = temporaryDirectory("relative-missing");

    let caught: unknown;
    try {
      resolveScope({ agentDir, cwd: here, scope: "project:./gone", maxSessions: 500 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidProjectScopeError);
    const failure = caught as InvalidProjectScopeError;
    expect(failure.project).toBe("./gone");
    expect(failure.projectPath).toBe(path.resolve(here, "gone"));
    expect(failure.project).not.toBe(failure.projectPath);
    expect(failure.message).toContain(JSON.stringify(path.resolve(here, "gone")));
    expect(failure.message).not.toContain("./gone");
  });
});

describe("pre-existing scope strings", () => {
  const fixture = () => {
    const agentDir = temporaryDirectory("agent-existing");
    const project = temporaryDirectory("existing-project");
    const other = temporaryDirectory("existing-other");
    const projectFile = writeProjectSession(
      agentDir,
      project,
      `-tmp-${tempSegment(project)}`,
      "project-session",
      "SCOPE_TOKEN_PROJECT",
    );
    const otherFile = writeProjectSession(
      agentDir,
      other,
      `-tmp-${tempSegment(other)}`,
      "other-session",
      "SCOPE_TOKEN_OTHER",
    );
    return { agentDir, project, projectFile, otherFile };
  };

  it("keeps bare project on the session cwd", () => {
    const { agentDir, project, projectFile, otherFile } = fixture();
    const resolution = resolveScope({ agentDir, cwd: project, scope: "project", maxSessions: 500 });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([projectFile]);
    expect(resolution.refs.map((ref) => ref.file)).not.toContain(otherFile);
  });

  it("keeps session on the newest session for the cwd", () => {
    const { agentDir, project, projectFile } = fixture();
    const resolution = resolveScope({ agentDir, cwd: project, scope: "session", maxSessions: 500 });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([projectFile]);
  });

  it("keeps session on the invoking session file when one is supplied", () => {
    const { agentDir, project, otherFile } = fixture();
    const resolution = resolveScope({
      agentDir,
      cwd: project,
      scope: "session",
      sessionFile: otherFile,
      maxSessions: 500,
    });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([otherFile]);
  });

  it("keeps global spanning every project", () => {
    const { agentDir, project, projectFile, otherFile } = fixture();
    const resolution = resolveScope({ agentDir, cwd: project, scope: "global", maxSessions: 500 });
    expect(resolution.refs.map((ref) => ref.file).sort()).toEqual([projectFile, otherFile].sort());
  });

  it("keeps session:<id> addressing one session anywhere", () => {
    const { agentDir, project, otherFile } = fixture();
    const resolution = resolveScope({
      agentDir,
      cwd: project,
      scope: "session:other-session",
      maxSessions: 500,
    });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([otherFile]);
  });

  it("keeps an unknown scope falling back to session", () => {
    const { agentDir, project, projectFile } = fixture();
    const resolution = resolveScope({ agentDir, cwd: project, scope: "nonsense", maxSessions: 500 });
    expect(resolution.refs.map((ref) => ref.file)).toEqual([projectFile]);
  });
});