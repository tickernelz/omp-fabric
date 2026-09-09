import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LcmLedger } from "../../src/storage/lcm-ledger.js";

type Closer = () => void | Promise<void>;

const LOCK_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const roots: string[] = [];
const closers: Closer[] = [];

export const tempRoot = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

export const closeAfterTest = <T>(value: T, close: (value: T) => void | Promise<void>): T => {
  closers.push(() => close(value));
  return value;
};

export const openLedger = (...args: ConstructorParameters<typeof LcmLedger>): LcmLedger =>
  closeAfterTest(new LcmLedger(...args), ledger => ledger.close());

const releaseHandles = (): void => {
  (globalThis as { Bun?: { gc: (force: boolean) => void } }).Bun?.gc(true);
};

const remove = (root: string): void => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !code || !LOCK_CODES.has(code)) throw error;
  }
};

export const releaseTemp = async (): Promise<void> => {
  let failed = false;
  let failure: unknown;
  while (closers.length > 0) {
    const close = closers.pop();
    try {
      await close?.();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  releaseHandles();
  for (const root of roots.splice(0)) remove(root);
  if (failed) throw failure;
};
