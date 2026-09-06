import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandAvailable } from "../src/agents/transports/process-utils.js";
import {
  resolveScriptRuntime,
  resolveScriptRuntimeSync,
  scriptSpawnArgs,
  workerCommand,
} from "../src/agents/transports/process-utils.js";

// path.basename splits on the host platform's separators, so a Windows-style
// "C:\\...\\node.exe" only basename-splits to node.exe on win32. Assert it
// only there; the other cases (with "/") split correctly on every platform.
const genericExecPaths = ["/usr/local/bin/node", "/usr/local/bin/bun", "/x/bun.exe"];
if (process.platform === "win32") genericExecPaths.push("C:\\node\\node.exe", "C:\\bun\\bun.exe");

describe("script runtime resolution", () => {
  it("reuses process.execPath when it is a generic node/bun runtime", async () => {
    for (const execPath of genericExecPaths) {
      expect(resolveScriptRuntimeSync({ execPath })).toBe(execPath);
      expect(await resolveScriptRuntime({ execPath })).toBe(execPath);
    }
  });

  it("falls back to OMP_FABRIC_NODE_BINARY when execPath is the compiled OMP binary", async () => {
    const execPath = "/usr/local/bin/omp";
    const override = "/opt/node-v22/bin/node";
    expect(
      resolveScriptRuntimeSync({ execPath, env: { OMP_FABRIC_NODE_BINARY: override } }),
    ).toBe(override);
    expect(
      await resolveScriptRuntime({ execPath, env: { OMP_FABRIC_NODE_BINARY: override } }),
    ).toBe(override);
  });

  it("builds the full spawn argv prefix through scriptSpawnArgs", async () => {
    const args = await scriptSpawnArgs(
      "/fabric/worker.js",
      ["--task-file", "/tmp/task.txt"],
      { execPath: "/usr/local/bin/omp", env: { OMP_FABRIC_NODE_BINARY: "/opt/node" } },
    );
    expect(args).toEqual(["/opt/node", "/fabric/worker.js", "--task-file", "/tmp/task.txt"]);
  });

  it("quotes every token in workerCommand using the resolved runtime", async () => {
    const command = await workerCommand("/fabric/worker.js", ["--task-file", "/tmp/task.txt"]);
    const runtime = resolveScriptRuntimeSync();
    expect(command.startsWith(`'${runtime}'`)).toBe(true);
    expect(command).toContain("'/fabric/worker.js'");
    expect(command).toContain("'/tmp/task.txt'");
  });

  it("resolves node or bun from the supplied PATH when the bundled binary has no override", async () => {
    const node = await commandAvailable("node");
    const bun = await commandAvailable("bun");
    if (!node && !bun) return; // neither runtime discoverable in this environment
    const runtime = await resolveScriptRuntime({
      execPath: "/usr/local/bin/omp",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(["node", "bun"]).toContain(path.basename(runtime).replace(/\.exe$/, ""));
    expect(path.isAbsolute(runtime)).toBe(true);
  });

  it("throws a clear error when the bundled binary has no runtime and no override", () => {
    expect(() => resolveScriptRuntimeSync({ execPath: "/usr/local/bin/omp", env: {} })).toThrow(
      /requires a Node\.js or Bun runtime|OMP_FABRIC_NODE_BINARY/,
    );
  });

  it("requireNode accepts a node execPath but rejects a bun execPath", () => {
    expect(resolveScriptRuntimeSync({ execPath: "/usr/local/bin/node", requireNode: true })).toBe(
      "/usr/local/bin/node",
    );
    expect(() =>
      resolveScriptRuntimeSync({ execPath: "/usr/local/bin/bun", requireNode: true }),
    ).toThrow();
  });
});
