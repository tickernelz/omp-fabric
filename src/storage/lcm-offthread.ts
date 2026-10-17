import { Worker } from "node:worker_threads";

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const openReadOnly = (file) => {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } catch {}
  const { Database } = require("bun:sqlite");
  return new Database(file, { readonly: true });
};
let db;
try {
  db = openReadOnly(workerData.file);
} catch (error) {
  parentPort.postMessage({ unavailable: error instanceof Error ? error.message : String(error) });
}
if (db) {
  try {
    if (workerData.snapshot) db.exec("BEGIN");
    const rows = workerData.statements.map((sql) => ({ ...(db.prepare(sql).get() ?? {}) }));
    if (workerData.snapshot) db.exec("COMMIT");
    parentPort.postMessage({ rows });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    try { db.close(); } catch {}
  }
}
`;

type OffThreadReply = { rows?: Array<Record<string, unknown>>; error?: string; unavailable?: string };

export interface OffThreadQuery {
  file: string;
  statements: readonly string[];
  snapshot?: boolean;
  signal?: AbortSignal;
}

/** Runs read-only single-row ledger statements on a worker thread; resolves undefined when the caller must run them inline. */
export const queryLedgerOffThread = (query: OffThreadQuery): Promise<Array<Record<string, unknown>> | undefined> =>
  new Promise((resolve, reject) => {
    if (query.signal?.aborted) { reject(new Error("ledger closed")); return; }
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { file: query.file, statements: [...query.statements], snapshot: query.snapshot === true },
      });
    } catch {
      resolve(undefined);
      return;
    }
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      query.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = (): void => finish(() => reject(new Error("ledger closed")));
    query.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: OffThreadReply) => {
      if (message.unavailable !== undefined) finish(() => resolve(undefined));
      else if (message.error !== undefined) finish(() => reject(new Error(message.error)));
      else if (Array.isArray(message.rows) && message.rows.length === query.statements.length) finish(() => resolve(message.rows));
      else finish(() => resolve(undefined));
    });
    worker.once("error", () => finish(() => resolve(undefined)));
    worker.once("exit", () => finish(() => resolve(undefined)));
  });
