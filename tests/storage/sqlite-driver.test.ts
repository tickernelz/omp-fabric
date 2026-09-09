import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqliteDriver, setSqliteDriver, type SqliteDatabase, type SqliteDriver } from "../../src/storage/sqlite.js";
import { canonicalLcmPayload } from "../../src/storage/lcm-identity.js";
import { LcmLedger } from "../../src/storage/lcm-ledger.js";
import { LcmMaintenance } from "../../src/compaction/lcm-maintenance.js";
import { releaseTemp, tempRoot } from "../fixtures/lcm-temp.js";

const { Database } = (await import("bun:sqlite" as string)) as {
  Database: new (target: string, options?: Record<string, unknown>) => SqliteDatabase;
};

const bunOnlyDriver = class BunOnlyDatabase implements SqliteDatabase {
  private readonly database: SqliteDatabase;
  constructor(target: string, options: { readOnly?: boolean } = {}) {
    this.database = new Database(target, options.readOnly ? { readonly: true } : { create: true });
  }
  exec(sql: string): void { this.database.exec(sql); }
  prepare(sql: string) { return this.database.prepare(sql); }
  close(): void { this.database.close(); }
} as unknown as SqliteDriver;

const entryFor = (ledger: LcmLedger, id: string) => ({
  projectKey: ledger.project.key,
  sessionId: "s",
  entryId: id,
  role: "user",
  content: id,
  payloadJson: canonicalLcmPayload({ type: "message", id, parentId: null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: id }] } }),
});

afterEach(async () => {
  setSqliteDriver(undefined);
  await loadSqliteDriver();
  await releaseTemp();
});

describe("SQLite driver", () => {
  it("runs the ledger on bun:sqlite when node:sqlite is unavailable", () => {
    setSqliteDriver(bunOnlyDriver);
    const root = tempRoot("lcm-bun-driver-");
    const dbPath = path.join(root, "ledger.sqlite");
    let ledger = new LcmLedger({ dbPath, project: { liveCwd: root } });
    const first = ledger.appendRaw(entryFor(ledger, "a"));
    ledger.appendRaw(entryFor(ledger, "b"));

    expect(ledger.appendRaw(entryFor(ledger, "a"))).toEqual(first);
    expect(ledger.readRaw()).toHaveLength(2);

    const leaf = new LcmMaintenance(ledger).createLeaf(ledger.readRaw());
    expect(leaf?.sources).toHaveLength(2);

    const backup = path.join(root, "backup.sqlite");
    expect(ledger.backup(backup).integrity).toBe("ok");
    expect(ledger.checkpoint("truncate").truncated).toBe(true);

    expect(() => ledger.transaction(() => { ledger.appendRaw(entryFor(ledger, "c")); throw new Error("abort"); })).toThrow("abort");
    expect(ledger.readRaw()).toHaveLength(2);

    ledger.close();
    ledger = new LcmLedger({ dbPath, project: { liveCwd: root } });
    expect(ledger.readRaw().map((row) => row.entryId)).toEqual(["a", "b"]);
    ledger.close();
    expect(fs.existsSync(backup)).toBe(true);
  });
});
