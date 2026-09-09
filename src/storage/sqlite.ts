import { createRequire } from "node:module";

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteOpenOptions { readOnly?: boolean }
export type SqliteDriver = new (path: string, options?: SqliteOpenOptions) => SqliteDatabase;

const SQLITE_UNAVAILABLE =
  "no SQLite driver: this runtime provides neither node:sqlite nor bun:sqlite";

let driver: SqliteDriver | undefined;

const bunDriver = (Database: new (path: string, options?: Record<string, unknown>) => SqliteDatabase): SqliteDriver =>
  class BunSqliteDatabase implements SqliteDatabase {
    private readonly database: SqliteDatabase;
    constructor(path: string, options: SqliteOpenOptions = {}) {
      this.database = new Database(path, options.readOnly ? { readonly: true } : { create: true });
    }
    exec(sql: string): void { this.database.exec(sql); }
    prepare(sql: string): SqliteStatement { return this.database.prepare(sql); }
    close(): void { this.database.close(); }
  } as SqliteDriver;

export const loadSqliteDriver = async (): Promise<SqliteDriver> => {
  if (driver) return driver;
  try {
    driver = (await import("node:sqlite")).DatabaseSync as unknown as SqliteDriver;
    return driver;
  } catch {}
  try {
    const bun = await import("bun:sqlite" as string) as { Database: new (path: string, options?: Record<string, unknown>) => SqliteDatabase };
    driver = bunDriver(bun.Database);
    return driver;
  } catch (error) {
    throw new Error(`${SQLITE_UNAVAILABLE} (${error instanceof Error ? error.message : String(error)})`);
  }
};

const requireModule = createRequire(import.meta.url);

const resolveSync = (): SqliteDriver | undefined => {
  try {
    return (requireModule("node:sqlite") as { DatabaseSync: SqliteDriver }).DatabaseSync;
  } catch {}
  try {
    const bun = requireModule("bun:sqlite") as { Database: new (path: string, options?: Record<string, unknown>) => SqliteDatabase };
    return bunDriver(bun.Database);
  } catch {}
  return undefined;
};

export const sqliteDriver = (): SqliteDriver => {
  driver ??= resolveSync();
  if (!driver) throw new Error(SQLITE_UNAVAILABLE);
  return driver;
};

export const setSqliteDriver = (next: SqliteDriver | undefined): void => { driver = next; };
