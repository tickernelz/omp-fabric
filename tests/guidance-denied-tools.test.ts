import { describe, expect, it } from "vitest";
import { deniedOmpCoreTools } from "../src/core/omp-tools.js";
import {
  defaultFabricExecutionGuidance,
  fabricExecutionKernelGuidance,
} from "../src/core/system-guidance.js";

const examplesSection = (guidance: string): string =>
  guidance.slice(0, guidance.indexOf("\n`tools`"));

describe("MCP call paths in the execution guidance", () => {
  it("separates Fabric's own MCP servers from the ones OMP loaded", () => {
    const guidance = defaultFabricExecutionGuidance(true);
    expect(guidance).toContain("servers Fabric itself pools (`mcp.$servers()`) as `mcp.<sanitized_server>.<sanitized_tool>(args)`");
    expect(guidance).toContain("MCP servers OMP loaded");
    expect(guidance).toContain("`extensions.mcp__<server>_<tool>(args)`");
  });
});

describe("execution guidance against a host without ls", () => {
  it("drops the omp.ls example when the host denies ls", () => {
    const withLs = defaultFabricExecutionGuidance(true);
    expect(examplesSection(withLs)).toContain("`omp.ls('src')`");

    const withoutLs = defaultFabricExecutionGuidance(true, ["ls"]);
    expect(examplesSection(withoutLs)).not.toContain("omp.ls");
    expect(examplesSection(withoutLs)).toContain("`omp.read('/x')`");
    expect(examplesSection(withoutLs)).toContain("return strings;");
  });

  it("keeps the example when other tools are denied", () => {
    const guidance = defaultFabricExecutionGuidance(true, ["edit", "write"]);
    expect(examplesSection(guidance)).toContain("`omp.ls('src')`");
    expect(guidance).toContain("`omp.edit");
  });

  it("names the denied tools as unavailable in the kernel guidance", () => {
    const guidance = fabricExecutionKernelGuidance(true, ["ls"]);
    expect(guidance).toContain("`omp.ls` is unavailable");
    expect(guidance).not.toContain("`omp.ls` and");
  });

  it("drops the async sentence when the host denies wait", () => {
    expect(fabricExecutionKernelGuidance(true, [])).toContain("omp.wait()");
    expect(fabricExecutionKernelGuidance(true, [])).toContain("Pass `async: true` to start the command");

    const guidance = fabricExecutionKernelGuidance(true, ["wait"]);
    expect(guidance).not.toContain("omp.wait()");
    expect(guidance).toContain("`omp.wait` is unavailable");
    expect(guidance).toContain("guest tools turned off");
    expect(guidance).toContain("Pass `async: true` to start the command");
  });
});

describe("denied guest tools", () => {
  it("reports a denied wait, which is a guest tool rather than a core one", () => {
    expect(deniedOmpCoreTools(undefined)).toEqual([]);
    expect(deniedOmpCoreTools(new Set(["read", "bash", "edit", "write", "grep", "glob", "ls"]))).toEqual([
      "wait",
    ]);
    expect(deniedOmpCoreTools(new Set(["read", "bash", "glob", "wait"]))).toEqual([
      "edit",
      "write",
      "grep",
      "ls",
    ]);
  });
});
