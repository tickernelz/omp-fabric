import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  clearTransportStderr,
  commandAvailable,
  readTransportStderrSummary,
  resolveScriptRuntime,
  resolveScriptRuntimeSync,
  scriptSpawnArgs,
  transportStderrPath,
  workerCommand,
} from "../src/agents/transports/process-utils.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-runtime-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const binDirectory = (name: string, runtimes: string[]): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  for (const runtime of runtimes) {
    const file = path.join(directory, runtime);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  return directory;
};

const bothOnPath = binDirectory("both", ["node", "bun"]);
const nodeOnlyOnPath = binDirectory("node-only", ["node"]);

describe("script runtime resolution", () => {
  it("prefers bun over node when both are on PATH", async () => {
    const env = { PATH: bothOnPath };
    const execPath = "/usr/local/bin/omp";
    expect(resolveScriptRuntimeSync({ execPath, env })).toBe(path.join(bothOnPath, "bun"));
    expect(await resolveScriptRuntime({ execPath, env })).toBe(path.join(bothOnPath, "bun"));
  });

  it("prefers a bun on PATH over a node process.execPath", async () => {
    const env = { PATH: bothOnPath };
    expect(resolveScriptRuntimeSync({ execPath: "/usr/local/bin/node", env })).toBe(
      path.join(bothOnPath, "bun"),
    );
    expect(await resolveScriptRuntime({ execPath: "/usr/local/bin/node", env })).toBe(
      path.join(bothOnPath, "bun"),
    );
  });

  it("reuses process.execPath when it is already bun", async () => {
    const env = { PATH: bothOnPath };
    expect(resolveScriptRuntimeSync({ execPath: "/usr/local/bin/bun", env })).toBe(
      "/usr/local/bin/bun",
    );
    expect(await resolveScriptRuntime({ execPath: "/usr/local/bin/bun", env })).toBe(
      "/usr/local/bin/bun",
    );
  });

  it("falls back to node when no bun is available", async () => {
    const env = { PATH: nodeOnlyOnPath };
    expect(resolveScriptRuntimeSync({ execPath: "/usr/local/bin/omp", env })).toBe(
      path.join(nodeOnlyOnPath, "node"),
    );
    expect(resolveScriptRuntimeSync({ execPath: "/usr/local/bin/node", env })).toBe(
      "/usr/local/bin/node",
    );
  });

  it("lets OMP_FABRIC_NODE_BINARY win over every discovered runtime", async () => {
    const override = "/opt/custom/bun";
    for (const execPath of ["/usr/local/bin/omp", "/usr/local/bin/node", "/usr/local/bin/bun"]) {
      const env = { PATH: bothOnPath, OMP_FABRIC_NODE_BINARY: override };
      expect(resolveScriptRuntimeSync({ execPath, env })).toBe(override);
      expect(await resolveScriptRuntime({ execPath, env })).toBe(override);
    }
  });

  it("ignores a blank OMP_FABRIC_NODE_BINARY", () => {
    expect(
      resolveScriptRuntimeSync({
        execPath: "/usr/local/bin/omp",
        env: { PATH: bothOnPath, OMP_FABRIC_NODE_BINARY: "   " },
      }),
    ).toBe(path.join(bothOnPath, "bun"));
  });

  it("keeps requiring node for the node-only executor even when bun is on PATH", () => {
    expect(
      resolveScriptRuntimeSync({ execPath: "/usr/local/bin/omp", env: { PATH: bothOnPath }, requireNode: true }),
    ).toBe(path.join(bothOnPath, "node"));
    expect(resolveScriptRuntimeSync({ execPath: "/usr/local/bin/node", requireNode: true })).toBe(
      "/usr/local/bin/node",
    );
    expect(() =>
      resolveScriptRuntimeSync({ execPath: "/usr/local/bin/bun", requireNode: true }),
    ).toThrow();
  });

  it("builds the full spawn argv prefix through scriptSpawnArgs", async () => {
    const args = await scriptSpawnArgs(
      "/fabric/worker.js",
      ["--task-file", "/tmp/task.txt"],
      { execPath: "/usr/local/bin/omp", env: { OMP_FABRIC_NODE_BINARY: "/opt/bun" } },
    );
    expect(args).toEqual(["/opt/bun", "/fabric/worker.js", "--task-file", "/tmp/task.txt"]);
  });

  it("quotes every token in workerCommand using the resolved runtime", async () => {
    const command = await workerCommand("/fabric/worker.js", ["--task-file", "/tmp/task.txt"]);
    const runtime = resolveScriptRuntimeSync();
    expect(command.startsWith(`'${runtime}'`)).toBe(true);
    expect(command).toContain("'/fabric/worker.js'");
    expect(command).toContain("'/tmp/task.txt'");
  });

  it("resolves an absolute node or bun from the ambient PATH", async () => {
    if (!(await commandAvailable("node")) && !(await commandAvailable("bun"))) return;
    const runtime = await resolveScriptRuntime({
      execPath: "/usr/local/bin/omp",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(["node", "bun"]).toContain(
      path.basename(runtime).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, ""),
    );
    expect(path.isAbsolute(runtime)).toBe(true);
  });

  it("throws a clear error when no runtime is discoverable and no override is set", () => {
    expect(() => resolveScriptRuntimeSync({ execPath: "/usr/local/bin/omp", env: {} })).toThrow(
      /requires a Bun or Node\.js runtime|OMP_FABRIC_NODE_BINARY/,
    );
  });
});

describe("transport stderr capture", () => {
  const runDirectory = path.join(root, "run");
  fs.mkdirSync(runDirectory, { recursive: true });

  it("reports nothing when the worker wrote no stderr", () => {
    expect(readTransportStderrSummary(runDirectory)).toBeUndefined();
  });

  it("names the launching runtime and the failure line", () => {
    fs.writeFileSync(
      transportStderrPath(runDirectory),
      [
        "[fabric] launching worker with /usr/bin/node",
        "node:internal/modules/typescript:183",
        "Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is unsupported for files under node_modules",
        "    at stripTypeScriptModuleTypes (node:internal/modules/typescript:183:11)",
        "",
      ].join("\n"),
    );
    const summary = readTransportStderrSummary(runDirectory);
    expect(summary).toContain("/usr/bin/node");
    expect(summary).toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
  });

  it("reports the newest attempt and bounds the quoted output", () => {
    fs.writeFileSync(
      transportStderrPath(runDirectory),
      [
        "[fabric] launching worker with /usr/bin/node",
        "Error: first attempt died",
        "[fabric] launching worker with /usr/bin/bun",
        `Error: second attempt died ${"x".repeat(4_000)}`,
        "",
      ].join("\n"),
    );
    const summary = readTransportStderrSummary(runDirectory);
    expect(summary).toContain("/usr/bin/bun");
    expect(summary).toContain("second attempt died");
    expect(summary).not.toContain("first attempt died");
    expect((summary ?? "").length).toBeLessThan(500);
  });

  it("prefers the thrown error header over dumped error properties", () => {
    fs.writeFileSync(
      transportStderrPath(runDirectory),
      [
        "[fabric] launching worker with /usr/bin/node",
        "node:internal/modules/typescript:183",
        "Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules",
        "    at stripTypeScriptModuleTypes (node:internal/modules/typescript:183:11)",
        "  code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'",
        "",
      ].join("\n"),
    );
    expect(readTransportStderrSummary(runDirectory)).toBe(
      "/usr/bin/node: Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules",
    );
  });

  it("clears the capture file so successful runs leave nothing behind", () => {
    clearTransportStderr(runDirectory);
    expect(fs.existsSync(transportStderrPath(runDirectory))).toBe(false);
    expect(readTransportStderrSummary(runDirectory)).toBeUndefined();
    clearTransportStderr(path.join(root, "missing-run"));
  });
});
