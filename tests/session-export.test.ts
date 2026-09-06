import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_EXPORT_ENV,
  encodeSessionExportCwd,
  resolveSessionExportDir,
  sessionExportFileFor,
} from "../src/agents/session-export.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FABRIC_AGENT_MARKER, SessionExporter } from "../src/worker/session-export.js";

const savedEnv = process.env[SESSION_EXPORT_ENV];
const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-export-test-"));
  tempRoots.push(root);
  return root;
};

const config = (sessionExport: boolean, sessionExportDir = "") =>
  normalizeFabricConfig({ agents: { sessionExport, sessionExportDir } }).agents;

afterEach(() => {
  if (savedEnv === undefined) delete process.env[SESSION_EXPORT_ENV];
  else process.env[SESSION_EXPORT_ENV] = savedEnv;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("session export config", () => {
  it("defaults to enabled with an empty directory override", () => {
    const agents = normalizeFabricConfig({}).agents;
    expect(agents.sessionExport).toBe(true);
    expect(agents.sessionExportDir).toBe("");
  });

  it("parses explicit keys", () => {
    const agents = config(true, "~/usage-store");
    expect(agents.sessionExport).toBe(true);
    expect(agents.sessionExportDir).toBe("~/usage-store");
  });

  it("ignores a non-string directory override", () => {
    const agents = normalizeFabricConfig({ agents: { sessionExportDir: 42 } }).agents;
    expect(agents.sessionExportDir).toBe("");
  });
});

describe("resolveSessionExportDir", () => {
  it("returns undefined while the export is disabled, even with env/dir set", () => {
    process.env[SESSION_EXPORT_ENV] = "/tmp/env-root";
    expect(resolveSessionExportDir(config(false, "/tmp/config-root"))).toBeUndefined();
  });

  it("defaults to the OMP Fabric agent directory", () => {
    delete process.env[SESSION_EXPORT_ENV];
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
    expect(resolveSessionExportDir(config(true))).toBe(path.join(agentDir, "fabric"));
  });

  it("prefers the env override over the configured directory", () => {
    process.env[SESSION_EXPORT_ENV] = "/tmp/env-root";
    expect(resolveSessionExportDir(config(true, "/tmp/config-root"))).toBe("/tmp/env-root");
  });

  it("uses the configured directory when no env override is set", () => {
    delete process.env[SESSION_EXPORT_ENV];
    expect(resolveSessionExportDir(config(true, "/tmp/config-root"))).toBe("/tmp/config-root");
  });

  it("expands a leading tilde", () => {
    delete process.env[SESSION_EXPORT_ENV];
    expect(resolveSessionExportDir(config(true, "~/usage-store"))).toBe(
      path.join(os.homedir(), "usage-store"),
    );
  });
});

describe("encodeSessionExportCwd", () => {
  it("uses the OMP encoded absolute cwd session directory shape", () => {
    expect(encodeSessionExportCwd("/Users/dev/project")).toBe("--Users-dev-project--");
    expect(encodeSessionExportCwd("/")).toBe("----");
  });
});

describe("sessionExportFileFor", () => {
  it("builds <root>/sessions/.fabric/<encoded-cwd>/<timestamp>_<runId>.jsonl", () => {
    const file = sessionExportFileFor(
      "/tmp/root",
      "/Users/dev/project",
      "abc123",
      new Date("2026-08-14T05:22:13.123Z"),
    );
    expect(file).toBe(
      path.join(
        "/tmp/root",
        "sessions",
        ".fabric",
        "--Users-dev-project--",
        "2026-08-14T05-22-13-123Z_abc123.jsonl",
      ),
    );
  });

  it("produces filenames OMP tooling can sort and parse", () => {
    const file = sessionExportFileFor("/tmp/root", "/tmp", "run", new Date());
    const base = path.basename(file, ".jsonl");
    expect(base).not.toMatch(/[:.]/);
    expect(base).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_run$/);
  });
});

describe("SessionExporter", () => {
  const makeExporter = (name = "website-researcher") => {
    const root = makeTempRoot();
    const file = path.join(root, "sessions", "--tmp--", "run.jsonl");
    const exporter = new SessionExporter({ file, sessionId: "run-id-1", cwd: "/tmp", agentName: name });
    return { exporter, file };
  };

  const readLines = (file: string): Record<string, unknown>[] =>
    fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("creates nothing until the first attributed usage", () => {
    const { exporter, file } = makeExporter();
    exporter.push({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes a session header, fabricagent marker, and usage-only message lines", () => {
    const { exporter, file } = makeExporter();
    const at = Date.parse("2026-08-14T05:22:13.000Z");
    exporter.push(
      { input: 100, output: 20, cacheRead: 900, cacheWrite: 8, cost: 0.0042 },
      "claude-opus-4-6",
      "anthropic",
      at,
    );
    const lines = readLines(file);
    expect(lines).toHaveLength(3);

    const header = lines[0]!;
    expect(header).toMatchObject({ type: "session", version: 3, id: "run-id-1", cwd: "/tmp" });
    expect(typeof header.timestamp).toBe("string");

    const info = lines[1]!;
    expect(info.type).toBe("session_info");
    expect(info.name).toBe(`${FABRIC_AGENT_MARKER}website-researcher`);

    const message = lines[2]!;
    expect(message.type).toBe("message");
    expect(message.parentId).toBe("run-id-1");
    expect(message.timestamp).toBe("2026-08-14T05:22:13.000Z");
    const body = message.message as Record<string, unknown>;
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.provider).toBe("anthropic");
    expect(body).not.toHaveProperty("content");
    const usage = body.usage as Record<string, unknown>;
    expect(usage).toMatchObject({ input: 100, output: 20, cacheRead: 900, cacheWrite: 8 });
    expect(usage.totalTokens).toBe(100 + 20 + 900 + 8);
    expect(usage.cost).toEqual({ total: 0.0042 });
  });

  it("omits provider when unknown and falls back to `unknown` for the model", () => {
    const { exporter, file } = makeExporter();
    exporter.push({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, undefined, " ");
    const message = readLines(file)[2]!;
    const body = message.message as Record<string, unknown>;
    expect(body.model).toBe("unknown");
    expect(body).not.toHaveProperty("provider");
  });

  it("clamps negative reconciliation deltas instead of exporting them", () => {
    const { exporter, file } = makeExporter();
    exporter.push({ input: -3, output: 1, cacheRead: -9, cacheWrite: 0, cost: 0.001 }, "m");
    const usage = (readLines(file)[2]!.message as Record<string, unknown>).usage as Record<string, unknown>;
    expect(usage).toMatchObject({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1 });
  });

  it("satisfies the subset both parsers require (tokscale/ccusage contract)", () => {
    const { exporter, file } = makeExporter();
    exporter.push({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, "gpt-5");
    exporter.push({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.002 }, "gpt-5");
    const lines = readLines(file);
    // tokscale: header must be first; ccusage tolerates any order but message
    // lines need type/timestamp/message{role,model,usage{input,output,cacheRead,cacheWrite}}.
    expect(lines[0]!.type).toBe("session");
    const messages = lines.filter((line) => line.type === "message");
    expect(messages).toHaveLength(2);
    for (const entry of messages) {
      expect(typeof entry.id).toBe("string");
      expect(Date.parse(entry.timestamp as string)).not.toBeNaN();
      const body = entry.message as Record<string, unknown>;
      expect(body.role).toBe("assistant");
      expect(typeof body.model).toBe("string");
      const usage = body.usage as Record<string, unknown>;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        expect(typeof usage[key]).toBe("number");
      }
    }
    // Message ids unique per line so parser dedup keeps every turn.
    expect(new Set(messages.map((entry) => entry.id)).size).toBe(2);
    // And the attribution marker is present before any message line.
    expect(lines[1]!.type).toBe("session_info");
    expect(String(lines[1]!.name)).toMatch(/^fabricagent-/);
  });
});
