import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundModelOutput,
  configureOutputArtifactRetention,
  DEFAULT_OUTPUT_ARTIFACT_RETENTION,
  fabricStateDir,
  MAX_FAILURE_MODEL_OUTPUT_CHARS,
  lastOutputArtifactSweep,
  modelOutputBudget,
  OUTPUT_ARTIFACT_SWEEP_INTERVAL_MS,
  outputArtifactDir,
  outputArtifactRetention,
  resetOutputArtifactSweepSchedule,
  sweepOutputArtifacts,
  sweepOutputArtifactsIfDue,
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
    expect(fabricStateDir({ XDG_STATE_HOME: "/s", HOME: "/h" })).toBe(path.join("/s", "omp-fabric"));
    expect(fabricStateDir({ HOME: "/h" })).toBe(path.join("/h", ".local", "state", "omp-fabric"));
    expect(outputArtifactDir({ XDG_STATE_HOME: "/s" })).toBe(path.join("/s", "omp-fabric", "output"));
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

const artifactName = (stamp: number, pid?: number): string =>
  pid === undefined
    ? `output-${stamp.toString(36)}-${randomBytes(6).toString("hex")}.txt`
    : `output-${stamp.toString(36)}-p${pid.toString(36)}-${randomBytes(6).toString("hex")}.txt`;

const seedArtifact = async (
  directory: string,
  options: { bytes: number; ageMs: number; pid?: number; now: number },
): Promise<string> => {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, artifactName(options.now - options.ageMs, options.pid));
  await writeFile(file, "a".repeat(options.bytes), "utf8");
  const seconds = (options.now - options.ageMs) / 1_000;
  await utimes(file, seconds, seconds);
  return file;
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const DEAD_PID = 999_999;
const onlyThisProcessIsAlive = (pid: number): boolean => pid === process.pid;

const scratchDir = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "fabric-artifacts-"));
  scratch.push(root);
  return root;
};

describe("sweepOutputArtifacts", () => {
  it("removes overflow past the age window and keeps what a live session still points at", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    const staleDead = await seedArtifact(directory, { bytes: 32, ageMs: 8 * 86_400_000, pid: DEAD_PID, now });
    const staleLive = await seedArtifact(directory, { bytes: 32, ageMs: 8 * 86_400_000, pid: process.pid, now });
    const staleLegacy = await seedArtifact(directory, { bytes: 32, ageMs: 8 * 86_400_000, now });
    const freshDead = await seedArtifact(directory, { bytes: 32, ageMs: 3_600_000, pid: DEAD_PID, now });

    const result = await sweepOutputArtifacts({
      directory,
      retention: { maxAgeMs: 7 * 86_400_000, maxBytes: 1024 * 1024 },
      now,
      isOwnerAlive: onlyThisProcessIsAlive,
    });

    expect([...result.removed].sort()).toEqual([staleDead, staleLegacy].sort());
    expect(await exists(staleLive)).toBe(true);
    expect(await exists(freshDead)).toBe(true);
    expect(result.keptBytes).toBe(64);
  });

  it("evicts the oldest unowned overflow until the directory fits the size cap", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    const files: string[] = [];
    for (let index = 0; index < 5; index++) {
      files.push(await seedArtifact(directory, {
        bytes: 200 * 1024,
        ageMs: (5 - index) * 60_000,
        pid: DEAD_PID,
        now,
      }));
    }

    const result = await sweepOutputArtifacts({
      directory,
      retention: { maxAgeMs: 365 * 86_400_000, maxBytes: 512 * 1024 },
      now,
      isOwnerAlive: onlyThisProcessIsAlive,
    });

    expect(result.removed).toEqual([files[0], files[1], files[2]]);
    expect(result.keptBytes).toBe(400 * 1024);
    expect(await exists(files[3]!)).toBe(true);
    expect(await exists(files[4]!)).toBe(true);
    expect((await readdir(directory)).length).toBe(2);
  });

  it("keeps a live session's overflow even when the size cap cannot be met", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    const held: string[] = [];
    for (let index = 0; index < 3; index++) {
      held.push(await seedArtifact(directory, {
        bytes: 200 * 1024,
        ageMs: (10 - index) * 86_400_000,
        pid: process.pid,
        now,
      }));
    }

    const result = await sweepOutputArtifacts({
      directory,
      retention: { maxAgeMs: 86_400_000, maxBytes: 64 * 1024 },
      now,
      isOwnerAlive: onlyThisProcessIsAlive,
    });

    expect(result.removed).toEqual([]);
    expect(result.keptBytes).toBe(600 * 1024);
    expect(result.heldBytes).toBe(600 * 1024);
    expect(result.overBudgetBytes).toBe(600 * 1024 - 64 * 1024);
    for (const file of held) expect(await exists(file)).toBe(true);
  });

  it("protects the running process through the real liveness probe", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    const mine = await seedArtifact(directory, { bytes: 64, ageMs: 30 * 86_400_000, pid: process.pid, now });
    const legacy = await seedArtifact(directory, { bytes: 64, ageMs: 30 * 86_400_000, now });

    const result = await sweepOutputArtifacts({
      directory,
      retention: { maxAgeMs: 86_400_000, maxBytes: 1024 * 1024 },
      now,
    });

    expect(result.removed).toEqual([legacy]);
    expect(await exists(mine)).toBe(true);
  });

  it("ignores files that are not overflow artifacts", async () => {
    const directory = await scratchDir();
    const foreign = path.join(directory, "notes.txt");
    await writeFile(foreign, "keep me", "utf8");
    await utimes(foreign, 0, 0);

    const result = await sweepOutputArtifacts({
      directory,
      retention: { maxAgeMs: 1, maxBytes: 1 },
      now: Date.UTC(2026, 0, 30),
      isOwnerAlive: onlyThisProcessIsAlive,
    });

    expect(result.removed).toEqual([]);
    expect(await exists(foreign)).toBe(true);
  });

  it("reports nothing for a directory that does not exist", async () => {
    await expect(
      sweepOutputArtifacts({ directory: path.join(tmpdir(), "fabric-absent-artifacts") }),
    ).resolves.toEqual({ removed: [], keptBytes: 0, heldBytes: 0, overBudgetBytes: 0 });
  });
});

describe("output artifact retention policy", () => {
  it("bounds the state directory on the first overflow write and never drops the new artifact", async () => {
    const expectedDir = await useStateRoot("XDG_STATE_HOME");
    const stale = await seedArtifact(expectedDir, { bytes: 8 * 1024, ageMs: 30 * 86_400_000, now: Date.now() });
    const previous = outputArtifactRetention();
    configureOutputArtifactRetention({ maxAgeMs: 86_400_000, maxBytes: 4 * 1024 });
    resetOutputArtifactSweepSchedule();
    try {
      const full = "x".repeat(40_000);
      const result = await boundModelOutput(full, 1_000);

      expect(result.artifactPath).toBeDefined();
      expect(path.dirname(result.artifactPath!)).toBe(expectedDir);
      expect(await readFile(result.artifactPath!, "utf8")).toBe(full);
      expect(await exists(stale)).toBe(false);
      expect(await readdir(expectedDir)).toEqual([path.basename(result.artifactPath!)]);
    } finally {
      configureOutputArtifactRetention(previous);
    }
  });

  it("defaults to a seven-day, 256 MB bound", () => {
    expect(DEFAULT_OUTPUT_ARTIFACT_RETENTION).toEqual({
      maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxBytes: 256 * 1024 * 1024,
    });
  });
});

describe("output artifact sweep schedule", () => {
  it("sweeps the first overflow write, skips a write inside the interval, and sweeps again once it elapses", async () => {
    const expectedDir = await useStateRoot("XDG_STATE_HOME");
    const previous = outputArtifactRetention();
    const base = Date.UTC(2026, 1, 2);
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    configureOutputArtifactRetention({ maxAgeMs: 86_400_000, maxBytes: 64 * 1024 * 1024 });
    resetOutputArtifactSweepSchedule();
    try {
      const beforeFirst = await seedArtifact(expectedDir, { bytes: 32, ageMs: 30 * 86_400_000, now: base });
      await boundModelOutput("x".repeat(4_000), 1_000);
      expect(await exists(beforeFirst)).toBe(false);

      const beforeSecond = await seedArtifact(expectedDir, { bytes: 32, ageMs: 30 * 86_400_000, now: base });
      clock.mockReturnValue(base + OUTPUT_ARTIFACT_SWEEP_INTERVAL_MS - 1);
      await boundModelOutput("y".repeat(4_000), 1_000);
      expect(await exists(beforeSecond)).toBe(true);
      expect(lastOutputArtifactSweep()?.at).toBe(base);

      clock.mockReturnValue(base + OUTPUT_ARTIFACT_SWEEP_INTERVAL_MS);
      await boundModelOutput("z".repeat(4_000), 1_000);
      expect(await exists(beforeSecond)).toBe(false);
      expect(lastOutputArtifactSweep()?.at).toBe(base + OUTPUT_ARTIFACT_SWEEP_INTERVAL_MS);
    } finally {
      clock.mockRestore();
      configureOutputArtifactRetention(previous);
      resetOutputArtifactSweepSchedule();
    }
  });

  it("keeps the schedule armed across a config reload that changes nothing", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    const stale = await seedArtifact(directory, { bytes: 32, ageMs: 30 * 86_400_000, now });
    const previous = outputArtifactRetention();
    resetOutputArtifactSweepSchedule();
    try {
      const options = {
        directory,
        retention: { maxAgeMs: 86_400_000, maxBytes: 1024 * 1024 },
        now,
        isOwnerAlive: onlyThisProcessIsAlive,
      };
      await sweepOutputArtifactsIfDue({ ...options, now: now - 30 * 86_400_000 });
      configureOutputArtifactRetention(previous);

      expect(await sweepOutputArtifactsIfDue({ ...options, now: now - 30 * 86_400_000 + 1 })).toBeUndefined();
      expect(await exists(stale)).toBe(true);

      configureOutputArtifactRetention({ maxAgeMs: 86_400_000, maxBytes: 1024 * 1024 });
      expect(await sweepOutputArtifactsIfDue({ ...options, now: now - 30 * 86_400_000 + 2 })).toBeDefined();
    } finally {
      configureOutputArtifactRetention(previous);
      resetOutputArtifactSweepSchedule();
    }
  });

  it("lets one sweep win when overflow writes land together", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    const stale = await seedArtifact(directory, { bytes: 32, ageMs: 30 * 86_400_000, now });
    resetOutputArtifactSweepSchedule();
    try {
      const options = {
        directory,
        retention: { maxAgeMs: 86_400_000, maxBytes: 1024 * 1024 },
        now,
        isOwnerAlive: onlyThisProcessIsAlive,
      };
      const sweeps = await Promise.all([
        sweepOutputArtifactsIfDue(options),
        sweepOutputArtifactsIfDue(options),
        sweepOutputArtifactsIfDue(options),
      ]);

      expect(sweeps.filter((sweep) => sweep !== undefined)).toHaveLength(1);
      expect(sweeps.find((sweep) => sweep !== undefined)?.removed).toEqual([stale]);
    } finally {
      resetOutputArtifactSweepSchedule();
    }
  });

  it("reports the bytes running sessions keep above the cap instead of accepting them in silence", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    for (let index = 0; index < 3; index++) {
      await seedArtifact(directory, {
        bytes: 200 * 1024,
        ageMs: (10 - index) * 86_400_000,
        pid: process.pid,
        now,
      });
    }
    resetOutputArtifactSweepSchedule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sweep = await sweepOutputArtifactsIfDue({
        directory,
        retention: { maxAgeMs: 86_400_000, maxBytes: 64 * 1024 },
        now,
        isOwnerAlive: onlyThisProcessIsAlive,
      });

      expect(sweep?.removed).toEqual([]);
      expect(sweep?.heldBytes).toBe(600 * 1024);
      expect(sweep?.overBudgetBytes).toBe(600 * 1024 - 64 * 1024);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(String(600 * 1024 - 64 * 1024));
      expect(lastOutputArtifactSweep()).toEqual({ ...sweep, at: now });
    } finally {
      warn.mockRestore();
      resetOutputArtifactSweepSchedule();
    }
  });

  it("stays quiet when the sweep brings the directory back under the cap", async () => {
    const directory = await scratchDir();
    const now = Date.UTC(2026, 0, 30);
    for (let index = 0; index < 3; index++) {
      await seedArtifact(directory, {
        bytes: 200 * 1024,
        ageMs: (10 - index) * 86_400_000,
        pid: DEAD_PID,
        now,
      });
    }
    resetOutputArtifactSweepSchedule();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sweep = await sweepOutputArtifactsIfDue({
        directory,
        retention: { maxAgeMs: 365 * 86_400_000, maxBytes: 512 * 1024 },
        now,
        isOwnerAlive: onlyThisProcessIsAlive,
      });

      expect(sweep?.keptBytes).toBe(400 * 1024);
      expect(sweep?.heldBytes).toBe(0);
      expect(sweep?.overBudgetBytes).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      resetOutputArtifactSweepSchedule();
    }
  });
});

