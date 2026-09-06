import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableJsonHash } from "../src/core/stable-hash.js";
import {
  POOL_TRACKED_SESSIONS,
  POOL_TRACKED_VALUES,
  loadObservationPool,
  loadObservationPoolAsync,
  mergeObservationWindow,
  mergeObservationWindowAsync,
  observationIdentity,
  observationWindowDigest,
  poolToValueObservations,
  saveObservationPool,
  saveObservationPoolAsync,
  type EntropyObservationWindow,
  type EntropyValueObservation,
} from "../src/entropy/index.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-entropy-pool-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const obs = (
  ref: string,
  key: string,
  value: string | number | boolean,
  count?: number,
): EntropyValueObservation => ({ ref, key, value, ...(count === undefined ? {} : { count }) });

const window = (file: string, observations: EntropyValueObservation[]): EntropyObservationWindow => ({
  file,
  observations,
});

const levelEntry = (
  pool: ReturnType<typeof mergeObservationWindow>,
  ref = "mcp.flags.set",
  key = "level",
) => pool.file.entries.find((entry) => entry.ref === ref && entry.key === key);

describe("mergeObservationWindow", () => {
  it("keeps window digests byte-compatible with sorted identity arrays", () => {
    const observations = [
      obs("mcp.flags.set", "level", "warn", 3),
      obs("mcp.flags.set", "level", "info"),
      obs("mcp.flags.set", "level", "warn"),
    ];
    expect(observationWindowDigest(observations)).toBe(
      stableJsonHash(observations.map(observationIdentity).sort()),
    );
  });

  it("matches the pure merge while yielding through a large window", async () => {
    const observations = Array.from({ length: 1_024 }, (_, index) =>
      obs("mcp.flags.set", "level", index % 3 === 0 ? "warn" : "info"),
    );
    const windows = [window("large.jsonl", observations)];
    const expected = mergeObservationWindow(undefined, windows);
    let turns = 0;
    let running = true;
    const pulse = (): void => {
      turns += 1;
      if (running) setImmediate(pulse);
    };
    setImmediate(pulse);
    const actual = await mergeObservationWindowAsync(undefined, windows);
    running = false;
    expect(turns).toBeGreaterThanOrEqual(4);
    expect(actual).toEqual(expected);
  });

  it("accumulates windows and never double counts an unchanged session", () => {
    const first = mergeObservationWindow(undefined, [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 3)]),
    ]);
    expect(first.mergedSessions).toBe(1);
    expect(poolToValueObservations(first.file)).toEqual([
      { ref: "mcp.flags.set", key: "level", value: "info", count: 3 },
    ]);
    const again = mergeObservationWindow(first.file, [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 3)]),
    ]);
    expect(again.mergedSessions).toBe(0);
    expect(again.skippedSessions).toBe(1);
    expect(JSON.stringify(again.file)).toBe(JSON.stringify(first.file));
  });

  it("applies exact deltas when a tracked session grows or is rewritten", () => {
    const first = mergeObservationWindow(undefined, [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 3)]),
    ]);
    const grown = mergeObservationWindow(first.file, [
      window("a.jsonl", [
        obs("mcp.flags.set", "level", "info", 3),
        obs("mcp.flags.set", "level", "warn"),
      ]),
    ]);
    expect(grown.mergedSessions).toBe(1);
    expect(poolToValueObservations(grown.file)).toEqual([
      { ref: "mcp.flags.set", key: "level", value: "info", count: 3 },
      { ref: "mcp.flags.set", key: "level", value: "warn", count: 1 },
    ]);
    const rewritten = mergeObservationWindow(grown.file, [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 1)]),
    ]);
    expect(rewritten.mergedSessions).toBe(1);
    expect(poolToValueObservations(rewritten.file)).toEqual([
      { ref: "mcp.flags.set", key: "level", value: "info", count: 1 },
    ]);
  });

  it("counts an identical multiset once across paths", () => {
    const first = mergeObservationWindow(undefined, [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 2)]),
    ]);
    const second = mergeObservationWindow(first.file, [
      window("b.jsonl", [obs("mcp.flags.set", "level", "info", 2)]),
    ]);
    expect(second.mergedSessions).toBe(0);
    expect(second.skippedSessions).toBe(1);
    expect(levelEntry(second)!.total).toBe(2);
  });

  it("bakes evicted tracked sessions and never re-merges their digest", () => {
    const windows: EntropyObservationWindow[] = [];
    for (let index = 0; index <= POOL_TRACKED_SESSIONS; index += 1) {
      windows.push(window(`s${index}.jsonl`, [obs("mcp.flags.set", "level", `v${index}`)]));
    }
    const merged = mergeObservationWindow(undefined, windows);
    expect(merged.mergedSessions).toBe(POOL_TRACKED_SESSIONS + 1);
    expect(merged.file.tracked).toHaveLength(POOL_TRACKED_SESSIONS);
    expect(merged.file.baked).toHaveLength(1);
    const remerged = mergeObservationWindow(merged.file, [windows[0]!]);
    expect(remerged.mergedSessions).toBe(0);
    expect(remerged.skippedSessions).toBe(1);
  });

  it("caps tracked values past the distinct guard and keeps totals honest", () => {
    const values: EntropyValueObservation[] = [];
    for (let index = 1; index <= 20; index += 1) {
      values.push(obs("mcp.flags.set", "level", `v${index}`));
    }
    const merged = mergeObservationWindow(undefined, [window("big.jsonl", values)]);
    const entry = levelEntry(merged)!;
    expect(entry.values).toHaveLength(POOL_TRACKED_VALUES);
    expect(entry.total).toBe(POOL_TRACKED_VALUES);
    // Eviction drops the lowest-count values, tie-broken by largest
    // value key in code-unit order ("string:v9" sorts after "string:v10"),
    // so v6 through v9 are the four evicted here.
    expect(entry.values.map((item) => item.value)).toEqual([
      "v1", "v10", "v11", "v12", "v13", "v14", "v15", "v16",
      "v17", "v18", "v19", "v2", "v20", "v3", "v4", "v5",
    ]);
  });

  it("is deterministic for identical merges", () => {
    const windows = [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 3), obs("mcp.flags.set", "level", "warn")]),
      window("b.jsonl", [obs("mcp.other.run", "mode", "fast", 2)]),
    ];
    const left = mergeObservationWindow(undefined, windows);
    const right = mergeObservationWindow(undefined, windows);
    expect(JSON.stringify(left.file)).toBe(JSON.stringify(right.file));
  });
});

describe("observation pool store", () => {
  it("round-trips the pool, no-ops identical writes, and surfaces damage", async () => {
    const agentDir = makeTempDir();
    expect(loadObservationPool(agentDir)).toEqual({});
    const merged = mergeObservationWindow(undefined, [
      window("a.jsonl", [obs("mcp.flags.set", "level", "info", 3)]),
    ]);
    const saved = saveObservationPool(agentDir, merged.file);
    expect(saved.written).toBe(true);
    const loaded = loadObservationPool(agentDir);
    expect(loaded.error).toBeUndefined();
    expect(loaded.file).toEqual(merged.file);
    expect(saveObservationPool(agentDir, merged.file).written).toBe(false);
    expect((await saveObservationPoolAsync(agentDir, merged.file)).written).toBe(false);
    expect(await loadObservationPoolAsync(agentDir)).toEqual({ file: merged.file });
    const file = path.join(agentDir, "fabric", "entropy", "observation-pool.json");
    fs.writeFileSync(file, "{ nope");
    const damaged = loadObservationPool(agentDir);
    expect(damaged.error).toBe("observation pool is malformed JSON");
    // Damage blocks the overwrite instead of silently rebuilding.
    expect(() => saveObservationPool(agentDir, merged.file)).toThrow(
      "observation pool is malformed JSON",
    );
    await expect(saveObservationPoolAsync(agentDir, merged.file)).rejects.toThrow(
      "observation pool is malformed JSON",
    );
  });
});
