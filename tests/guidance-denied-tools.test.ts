import { describe, expect, it } from "vitest";
import {
  defaultFabricExecutionGuidance,
  fabricExecutionKernelGuidance,
} from "../src/core/system-guidance.js";

const examplesSection = (guidance: string): string =>
  guidance.slice(0, guidance.indexOf("\n`tools`"));

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
});
