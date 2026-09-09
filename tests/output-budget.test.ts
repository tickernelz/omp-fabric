import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundModelOutput,
  fabricStateDir,
  MAX_FAILURE_MODEL_OUTPUT_CHARS,
  modelOutputBudget,
  outputArtifactDir,
} from "../src/output-budget.js";

const originalXdgState = process.env.XDG_STATE_HOME;
const originalHome = process.env.HOME;
const scratch: string[] = [];

const useStateRoot = async (variable: "XDG_STATE_HOME" | "HOME"): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "fabric-state-"));
  scratch.push(root);
  if (variable === "XDG_STATE_HOME") {
    process.env.XDG_STATE_HOME = root;
    return path.join(root, "omp-fabric", "output");
  }
  delete process.env.XDG_STATE_HOME;
  process.env.HOME = root;
  return path.join(root, ".local", "state", "omp-fabric", "output");
};

afterEach(async () => {
  if (originalXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgState;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("modelOutputBudget", () => {
  it("caps failures without reducing successful or stricter configured budgets", () => {
    expect(modelOutputBudget(50_000, true)).toBe(50_000);
    expect(modelOutputBudget(50_000, false)).toBe(MAX_FAILURE_MODEL_OUTPUT_CHARS);
    expect(modelOutputBudget(10_000, false)).toBe(10_000);
  });
});

describe("fabricStateDir", () => {
  it("prefers XDG_STATE_HOME and falls back to the home state directory", () => {
    expect(fabricStateDir({ XDG_STATE_HOME: "/s", HOME: "/h" })).toBe("/s/omp-fabric");
    expect(fabricStateDir({ HOME: "/h" })).toBe("/h/.local/state/omp-fabric");
    expect(outputArtifactDir({ XDG_STATE_HOME: "/s" })).toBe("/s/omp-fabric/output");
  });
});

describe("boundModelOutput", () => {
  it("leaves output under budget untouched", async () => {
    const writer = vi.fn(async () => "/tmp/full.txt");
    await expect(boundModelOutput("small", 1_000, "small", writer)).resolves.toEqual({
      text: "small",
      originalChars: 5,
      omittedChars: 0,
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it("bounds visible text and links the complete artifact", async () => {
    const full = `start-${"x".repeat(4_000)}-end`;
    const writer = vi.fn(async () => "/state/omp-fabric/output/output-a.txt");
    const result = await boundModelOutput(full, 1_000, full, writer);

    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain("start-");
    expect(result.text).toContain("-end");
    expect(result.text).toContain("Full output (4010 chars) saved to:");
    expect(result.artifactPath).toBe("/state/omp-fabric/output/output-a.txt");
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(writer).toHaveBeenCalledWith(full);
  });

  it("stores the overflow under the fabric state directory, not the OS temp directory", async () => {
    const expectedDir = await useStateRoot("XDG_STATE_HOME");
    const full = "x".repeat(4_000);

    const result = await boundModelOutput(full, 1_000);

    expect(result.artifactPath).toBeDefined();
    expect(path.dirname(result.artifactPath!)).toBe(expectedDir);
    expect(await readFile(result.artifactPath!, "utf8")).toBe(full);
    if (process.platform !== "win32") {
      expect((await stat(result.artifactPath!)).mode & 0o777).toBe(0o600);
    }
  });

  it("falls back to the home state directory when XDG_STATE_HOME is unset", async () => {
    const expectedDir = await useStateRoot("HOME");

    const result = await boundModelOutput("y".repeat(4_000), 1_000);

    expect(path.dirname(result.artifactPath!)).toBe(expectedDir);
  });

  it("reports the failure in the visible text when the overflow cannot be saved", async () => {
    const writer = vi.fn(async () => { throw new Error("disk full"); });
    const result = await boundModelOutput("x".repeat(4_000), 1_000, undefined, writer);

    expect(result.artifactPath).toBeUndefined();
    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain(
      "[full output 4000 chars; overflow could not be saved: disk full]",
    );

    const noteStart = result.text.indexOf("\n\n[full output");
    expect(noteStart).toBeGreaterThan(0);
    expect(result.originalChars).toBe(4_000);
    expect(result.omittedChars).toBe(4_000 - result.text.slice(0, noteStart).length);
  });

  it("counts every omitted character when the visible rendering is far shorter than the full output", async () => {
    const writer = vi.fn(async () => { throw new Error("disk full"); });
    const result = await boundModelOutput("short", 1_000, "z".repeat(4_000), writer);

    expect(result.originalChars).toBe(4_000);
    expect(result.omittedChars).toBe(3_995);
  });
});
