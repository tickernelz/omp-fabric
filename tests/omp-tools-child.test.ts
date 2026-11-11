import { describe, expect, it } from "vitest";
import { OMP_CORE_TOOL_NAMES, ompChildToolName } from "../src/core/omp-tools.js";

describe("the tool names a child omp is launched with", () => {
  it("gives a core tool the host renames the host's name", () => {
    expect(ompChildToolName("find")).toBe("glob");
  });

  it("passes every other core tool through unchanged", () => {
    const passThrough = OMP_CORE_TOOL_NAMES.filter((name) => name !== "find" && name !== "ls");
    for (const name of passThrough) expect(ompChildToolName(name)).toBe(name);
  });

  it("gives a child no entry for ls, which the host has no built-in for", () => {
    expect(ompChildToolName("ls")).toBeUndefined();
  });

  it("leaves a tool fabric does not own alone", () => {
    expect(ompChildToolName("fabric_exec")).toBe("fabric_exec");
    expect(ompChildToolName("task")).toBe("task");
  });
});
