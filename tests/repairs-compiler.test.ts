import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uniqueDeclaredKeyForSpelling } from "../src/providers/arg-normalization.js";
import { RepairCompiler } from "../src/repairs/compiler.js";
import { loadRepairTable, saveRepairTable, saveRepairTableAsync } from "../src/repairs/store.js";
import { emptyRepairTable, type RepairTableFile } from "../src/repairs/types.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-repairs-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("uniqueDeclaredKeyForSpelling", () => {
  it("maps sessionId to session when unique", () => {
    expect(uniqueDeclaredKeyForSpelling("sessionId", ["session", "entryId"])).toBe("session");
    expect(uniqueDeclaredKeyForSpelling("session", ["session"])).toBeUndefined();
  });
});

describe("RepairCompiler", () => {
  it("promotes a unique key alias on first hit and then applies it", async () => {
    const agentDir = makeTempDir();
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    const args = { sessionId: "abc" };
    const declared = ["session", "entryId"];
    const schema = {
      type: "object",
      properties: { session: { type: "string" }, entryId: { type: "string" } },
      additionalProperties: false,
    };
    const promoted = compiler.observeInvalidArgs("memory.expand", args, declared, "extra");
    expect(promoted).toEqual({
      kind: "keyAlias",
      ref: "memory.expand",
      from: "sessionId",
      to: "session",
    });
    expect(compiler.applyArgs("memory.expand", { sessionId: "abc" }, schema)).toEqual({
      session: "abc",
    });
    expect(compiler.applyArgs("memory.expand", { session: "abc" }, schema)).toEqual({
      session: "abc",
    });
    expect(
      compiler.applyArgs("memory.expand", { sessionId: "abc" }, {
        ...schema,
        properties: { sessionId: { type: "string" }, entryId: { type: "string" } },
      }),
    ).toEqual({ sessionId: "abc" });
    await compiler.flush();
    const persisted = loadRepairTable(
      path.join(agentDir, "fabric", "repairs"),
      compiler.catalogDigest,
    ).table;
    expect(persisted.repairs).toHaveLength(1);
  });

  it("does not promote effect failures", () => {
    const compiler = new RepairCompiler({ agentDir: makeTempDir() });
    compiler.setCatalogSurface({ providers: ["omp"], capturedTools: [] });
    expect(
      compiler.observe({ stage: "effect", fingerprint: "effect:bash" }),
    ).toBeUndefined();
    expect(compiler.status().repairCount).toBe(0);
    expect(compiler.status().effectDropped).toBe(1);
  });

  it("clears in-memory counts when the catalog digest changes on the same instance", async () => {
    const agentDir = makeTempDir();
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    compiler.observeInvalidArgs(
      "memory.expand",
      { sessionId: "s" },
      ["session"],
      "extra",
    );
    expect(compiler.status().repairCount).toBe(1);
    await compiler.flush();
    compiler.setCatalogSurface({ providers: ["memory", "mesh"], capturedTools: [] });
    expect(compiler.status().repairCount).toBe(0);
    expect(compiler.status().fingerprints).toEqual([]);
    expect(
      compiler.observe({ stage: "invocation_args", fingerprint: "args:memory.expand:sessionId" }),
    ).toBeUndefined();
    expect(compiler.status().repairCount).toBe(0);
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    expect(compiler.status().repairCount).toBe(1);
  });

  it("starts empty when a new compiler loads a different digest", async () => {
    const agentDir = makeTempDir();
    const first = new RepairCompiler({ agentDir });
    first.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    first.observeInvalidArgs(
      "memory.expand",
      { sessionId: "s" },
      ["session"],
      "extra",
    );
    expect(first.status().repairCount).toBe(1);
    await first.flush();
    const second = new RepairCompiler({ agentDir });
    second.setCatalogSurface({ providers: ["memory", "mesh"], capturedTools: [] });
    expect(second.status().repairCount).toBe(0);
    const third = new RepairCompiler({ agentDir });
    third.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    expect(third.status().repairCount).toBe(1);
  });

  it("merges promotions from compiler instances sharing the same catalog", async () => {
    const agentDir = makeTempDir();
    const first = new RepairCompiler({ agentDir });
    const second = new RepairCompiler({ agentDir });
    const surface = { providers: ["memory"], capturedTools: [] };
    first.setCatalogSurface(surface);
    second.setCatalogSurface(surface);
    first.observeInvalidArgs(
      "memory.expand",
      { sessionId: "s" },
      ["session"],
      "extra",
    );
    second.observeUnknownAction("memory", "search", ["recall", "expand"]);
    await Promise.all([first.flush(), second.flush()]);
    const persisted = loadRepairTable(
      path.join(agentDir, "fabric", "repairs"),
      first.catalogDigest,
    ).table;
    expect(persisted.repairs).toEqual(expect.arrayContaining([
      { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
      { kind: "actionAlias", provider: "memory", from: "search", to: "recall" },
    ]));
    expect(persisted.repairs).toHaveLength(2);
  });

  it("keeps in-memory repair active when persistence fails", async () => {
    const agentDir = makeTempDir();
    fs.writeFileSync(path.join(agentDir, "fabric"), "not a directory");
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    expect(() =>
      compiler.observeInvalidArgs(
        "memory.expand",
        { sessionId: "s" },
        ["session"],
        "extra",
      )
    ).not.toThrow();
    expect(compiler.repairs).toHaveLength(1);
    await compiler.flush();
    expect(compiler.status().storeError).toBeTruthy();
  });

  it("loads valid rows while skipping removed repair kinds", () => {
    const agentDir = makeTempDir();
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    const directory = path.join(agentDir, "fabric", "repairs");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "current.json"), JSON.stringify({
      version: 1,
      catalogDigest: compiler.catalogDigest,
      repairs: [
        { kind: "guestPositional", tool: "read", arity: 2, keys: ["path"] },
        { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const loaded = new RepairCompiler({ agentDir });
    loaded.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    expect(loaded.repairs).toEqual([
      { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
    ]);
  });

  it("keeps promotion responsive while the durable table lock is contended", async () => {
    const agentDir = makeTempDir();
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    const directory = path.join(agentDir, "fabric", "repairs");
    const lock = path.join(directory, "current.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), `token\n${process.pid}\n${Date.now()}\n`);
    let eventLoopAdvanced = false;
    const timer = setTimeout(() => {
      eventLoopAdvanced = true;
    }, 10);

    expect(
      compiler.observeInvalidArgs("memory.expand", { sessionId: "s" }, ["session"], "extra"),
    ).toBeTruthy();
    expect(compiler.repairs).toHaveLength(1);
    expect(fs.existsSync(path.join(directory, "current.json"))).toBe(false);
    await compiler.flush();
    clearTimeout(timer);

    expect(eventLoopAdvanced).toBe(true);
    expect(compiler.status().storeError).toContain("lock");
  });

  it("surfaces a malformed table in status and never overwrites it", async () => {
    const agentDir = makeTempDir();
    const directory = path.join(agentDir, "fabric", "repairs");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "current.json"), "{ not json");
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    expect(compiler.status().storeError).toContain("malformed");
    expect(compiler.status().repairCount).toBe(0);
    expect(
      compiler.observeInvalidArgs("memory.expand", { sessionId: "s" }, ["session"], "extra"),
    ).toEqual({
      kind: "keyAlias",
      ref: "memory.expand",
      from: "sessionId",
      to: "session",
    });
    // The damaged file is preserved verbatim; the row stays active in memory
    // and the refusal stays visible in status.
    await compiler.flush();
    expect(compiler.status().storeError).toContain("malformed");
    expect(compiler.repairs).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, "current.json"), "utf8")).toBe("{ not json");
  });

  it("starts fresh on a missing table without reporting an error", () => {
    const agentDir = makeTempDir();
    const compiler = new RepairCompiler({ agentDir });
    compiler.setCatalogSurface({ providers: ["memory"], capturedTools: [] });
    expect(compiler.status().storeError).toBeUndefined();
    expect(compiler.status().repairCount).toBe(0);
  });
});

describe("repair table lock", () => {
  const table = (digest: string): RepairTableFile => emptyRepairTable(digest);

  it("reaps an ownerless stale lock left by a crash", () => {
    const agentDir = makeTempDir();
    const directory = path.join(agentDir, "fabric", "repairs");
    const lock = path.join(directory, "current.lock");
    fs.mkdirSync(lock, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    expect(saveRepairTable(directory, table("digest-1")).catalogDigest).toBe("digest-1");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reaps an ownerless stale lock asynchronously", async () => {
    const agentDir = makeTempDir();
    const directory = path.join(agentDir, "fabric", "repairs");
    const lock = path.join(directory, "current.lock");
    fs.mkdirSync(lock, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    expect((await saveRepairTableAsync(directory, table("digest-1"))).catalogDigest).toBe(
      "digest-1",
    );
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reaps a stale lock whose owner process is dead", () => {
    const agentDir = makeTempDir();
    const directory = path.join(agentDir, "fabric", "repairs");
    const lock = path.join(directory, "current.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), `token\n2_000_000_000\n${Date.now() - 60_000}\n`);
    expect(saveRepairTable(directory, table("digest-1")).catalogDigest).toBe("digest-1");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("fails visibly when a live process holds the lock", () => {
    const agentDir = makeTempDir();
    const directory = path.join(agentDir, "fabric", "repairs");
    const lock = path.join(directory, "current.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), `token\n${process.pid}\n${Date.now()}\n`);
    expect(() => saveRepairTable(directory, table("digest-1"))).toThrow(/lock/);
  });
});
