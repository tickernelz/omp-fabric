import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir, resolveScope } from "../src/memory/discovery.js";
import {
  MEMORY_CACHE_VERSION,
  digestPathForSession,
  loadDigest,
  loadShard,
  loadTieredIndex,
  shardPathForSession,
} from "../src/memory/index.js";
import { searchMemoryIndex } from "../src/memory/search.js";
import { tokenizeLexical } from "../src/memory/tokenize.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  assistantText,
  messageEntry,
  sessionHeader,
  userMessage,
  writeSessionFile,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `omp-fabric-memory-v6-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-v6",
  nestedToolCallId: "memory-v6-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const message = (id: string, text: string, offset = 0) =>
  messageEntry(
    id,
    null,
    new Date(1_700_000_000_000 + offset * 1_000).toISOString(),
    userMessage(text),
  );

const directorySize = (directory: string): number =>
  fs.readdirSync(directory).reduce((total, name) => total + fs.statSync(path.join(directory, name)).size, 0);

describe("memory cache V6", () => {
  let agentDir: string;
  let indexDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = temporaryDirectory("agent");
    indexDir = temporaryDirectory("index");
    cwd = "/work/cache-v4";
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const config = (overrides: Partial<FabricMemoryConfig> = {}): FabricMemoryConfig => ({
    enabled: true,
    indexDir,
    maxSessions: 10,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
    hotSessions: 50,
    digestTerms: 5,
    ...overrides,
  });

  const provider = (overrides: Partial<FabricMemoryConfig> = {}) =>
    new MemoryProvider({ agentDir, cwd, config: config(overrides) });

  it("searches every eligible session despite maxSessions and ranks the oldest rare fact first", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const base = Math.floor(Date.now() / 1_000) - 10_000;
    let oldest = "";
    for (let index = 0; index < 1_001; index += 1) {
      const rare = index === 0 ? " rarelexeme_000 Ωmega雪" : "";
      const file = writeSessionFile(sessionDirectory, `${String(index).padStart(4, "0")}.jsonl`, [
        sessionHeader(`session-${index}`, cwd),
        message(`entry-${index}`, `common distractor_${index}${rare}`, index),
      ]);
      fs.utimesSync(file, base + index, base + index);
      if (index === 0) oldest = file;
    }

    for (const scope of ["project", "global"]) {
      const result = await provider().invoke(
        "recall",
        { scope, query: "common rarelexeme_000", pageSize: 10 },
        invocationContext(cwd),
      ) as {
        hits: Array<{ kind: string; sessionId: string; follow: { ref: string } }>;
        coverage: { complete: boolean; indexedSessions: number; eligibleSessions: number; staleSessions: number; reasons: string[] };
      };
      expect(result.coverage).toEqual({
        complete: true,
        indexedSessions: 1_001,
        eligibleSessions: 1_001,
        staleSessions: 0,
        incompleteSessions: 0,
        reasons: [],
      });
      expect(result.hits[0]).toEqual(expect.objectContaining({
        kind: "session",
        sessionId: "session-0",
        follow: expect.objectContaining({ ref: "memory.recall" }),
      }));
    }

    const regexResult = await provider().invoke(
      "recall",
      { scope: "project", query: "^rarelexeme_[0-9]{3}$", queryMode: "regex" },
      invocationContext(cwd),
    ) as { hits: Array<{ sessionId: string }>; coverage: { complete: boolean } };
    expect(regexResult.hits.map((hit) => hit.sessionId)).toEqual(["session-0"]);
    expect(regexResult.coverage.complete).toBe(true);

    const unicodeResult = await provider().invoke(
      "recall",
      { scope: "project", query: "ΩMEGA雪" },
      invocationContext(cwd),
    ) as { hits: Array<{ sessionId: string }> };
    expect(unicodeResult.hits[0]!.sessionId).toBe("session-0");

    const digest = JSON.parse(
      fs.readFileSync(digestPathForSession(oldest, indexDir), "utf8"),
    ) as Record<string, unknown>;
    expect(digest.cacheVersion).toBe(MEMORY_CACHE_VERSION);
    expect(digest.kind).toBe("digest");
    expect(digest).not.toHaveProperty("entries");
    expect(digest).not.toHaveProperty("goalLine");
    expect(digest.vocabulary as string[]).toContain("rarelexeme_000");
    expect(directorySize(indexDir)).toBeLessThan(10 * 1024 * 1024);
    if (process.platform !== "win32") {
      expect(fs.statSync(indexDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(digestPathForSession(oldest, indexDir)).mode & 0o777).toBe(0o600);
    }
  }, 30_000);

  it("paginates no-query browsing without a pre-pagination session cap while query coverage is complete", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const base = Math.floor(Date.now() / 1_000) - 100;
    for (let index = 0; index < 20; index += 1) {
      const file = writeSessionFile(sessionDirectory, `${index}.jsonl`, [
        sessionHeader(`browse-${index}`, cwd),
        message(`e-${index}`, `browse token_${index}`),
      ]);
      fs.utimesSync(file, base + index, base + index);
    }
    const browse = await provider().invoke("recall", { scope: "project" }, invocationContext(cwd)) as {
      total: number;
      coverage: { eligibleSessions: number };
    };
    expect(browse.coverage.eligibleSessions).toBe(20);
    expect(browse.total).toBe(20);

    const search = await provider({ hotSessions: 1 }).invoke(
      "recall",
      { scope: "project", query: "token_0" },
      invocationContext(cwd),
    ) as { coverage: { complete: boolean; eligibleSessions: number }; hits: Array<{ sessionId: string }> };
    expect(search.coverage).toEqual(expect.objectContaining({ complete: true, eligibleSessions: 20 }));
    expect(search.hits[0]!.sessionId).toBe("browse-0");
  });

  it("rebuilds rewritten and V5 caches and removes caches for deleted sources", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const file = writeSessionFile(sessionDirectory, "rewrite.jsonl", [
      sessionHeader("rewrite", cwd),
      message("same-id", "originalword"),
    ]);
    const oldTime = Math.floor(Date.now() / 1_000) - 100;
    fs.utimesSync(file, oldTime, oldTime);
    const ref = resolveScope({ agentDir, cwd, scope: "project", maxSessions: 100 })[0]!;
    const options = { indexDir, maxEntryChars: 2_000, hotSessions: 0, digestTerms: 2 };
    const first = loadDigest(ref, options);
    const v5 = { ...first, cacheVersion: 5, addresses: first.addresses.map((address) => address.slice(0, 6)) };
    fs.writeFileSync(digestPathForSession(file, indexDir), JSON.stringify(v5), "utf8");
    const rebuilt = loadDigest(ref, options);
    expect(rebuilt.cacheVersion).toBe(MEMORY_CACHE_VERSION);
    expect(rebuilt.vocabulary).toContain("originalword");

    const shard = loadShard(ref, { ...options, hotSessions: 1 });
    fs.writeFileSync(
      shardPathForSession(file, indexDir),
      JSON.stringify({ ...shard, cacheVersion: 5, indexCoverage: undefined, entries: [] }),
      "utf8",
    );
    const rebuiltShard = loadShard(ref, { ...options, hotSessions: 1 });
    expect(rebuiltShard.cacheVersion).toBe(MEMORY_CACHE_VERSION);
    expect(rebuiltShard.entries[0]!.text).toBe("originalword");

    const original = fs.readFileSync(file, "utf8");
    const rewritten = original.replace("originalword", "rewrittenxyz");
    expect(rewritten.length).toBe(original.length);
    fs.writeFileSync(file, rewritten, "utf8");
    fs.utimesSync(file, oldTime, oldTime);
    const rewrittenRef = resolveScope({ agentDir, cwd, scope: "project", maxSessions: 100 })[0]!;
    const refreshed = loadDigest(rewrittenRef, options);
    expect(refreshed.sourceHash).not.toBe(first.sourceHash);
    expect(refreshed.vocabulary).toContain("rewrittenxyz");
    expect(refreshed.vocabulary).not.toContain("originalword");

    const refsBeforeDelete = [rewrittenRef];
    fs.rmSync(file);
    const stale = loadTieredIndex(refsBeforeDelete, refsBeforeDelete, options);
    expect(stale.coverage).toEqual({
      complete: false,
      indexedSessions: 0,
      eligibleSessions: 1,
      staleSessions: 1,
      incompleteSessions: 0,
      reasons: ["source_unavailable"],
    });
    const empty = await searchMemoryIndex(stale.shards, stale.digests, { query: "rewrittenxyz" });
    expect(empty.items).toEqual([]);
    expect(empty.queryCoverage.complete).toBe(true);
    expect(fs.existsSync(digestPathForSession(file, indexDir))).toBe(false);
  });

  it("hydrates bounded ranges explicitly and expands by stable entry id", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const old = writeSessionFile(sessionDirectory, "old.jsonl", [
      sessionHeader("old", cwd),
      message("entry-a", "alpha fact", 0),
      messageEntry("entry-b", "entry-a", new Date(1_700_000_001_000).toISOString(), assistantText("rare bounded fact")),
      message("entry-c", "omega fact", 2),
    ]);
    const recent = writeSessionFile(sessionDirectory, "recent.jsonl", [
      sessionHeader("recent", cwd),
      message("recent-entry", "recent fact"),
    ]);
    const base = Math.floor(Date.now() / 1_000) - 100;
    fs.utimesSync(old, base, base);
    fs.utimesSync(recent, base + 1, base + 1);

    const pointer = await provider({ hotSessions: 1 }).invoke(
      "recall",
      { scope: "project", branches: "all", query: "bounded" },
      invocationContext(cwd),
    ) as { hits: Array<{ follow: { ref: string; args: Record<string, unknown> } }> };
    expect(pointer.hits[0]!.follow).toEqual(expect.objectContaining({
      ref: "memory.recall",
      args: expect.objectContaining({
        scope: `session:${old}`,
        expectedSourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));

    const hydrated = await provider({ hotSessions: 1 }).invoke(
      "recall",
      { ...pointer.hits[0]!.follow.args, entryRange: { first: 1, last: 1 } },
      invocationContext(cwd),
    ) as { hits: Array<{ index: number }> };
    expect(hydrated.hits.map((hit) => hit.index)).toEqual([1]);
    expect(fs.existsSync(shardPathForSession(old, indexDir))).toBe(false);

    const expanded = await provider({ hotSessions: 1 }).invoke(
      "expand",
      { session: "old", branches: "all", entryIds: ["entry-b"] },
      invocationContext(cwd),
    ) as { entries: { index: number; entryId: string; text: string }[] };
    expect(expanded.entries).toEqual([expect.objectContaining({
      index: 1,
      entryId: "entry-b",
      text: "rare bounded fact",
      textRange: { start: 0, end: 17, total: 17, complete: true },
    })]);
  });

  it("uses one Unicode-aware tokenizer for exact lexical terms", () => {
    expect(tokenizeLexical("CAFÉ café Ωmega雪 snake_case 42")).toEqual([
      "café",
      "café",
      "ωmega雪",
      "snake_case",
      "42",
    ]);
  });
});
