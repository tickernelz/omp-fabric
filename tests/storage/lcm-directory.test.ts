import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableProjectKey, sweepLedgers } from "../../src/storage/lcm-directory.js";
import { canonicalProjectIdentity, defaultLedgerPath, type ProjectIdentity } from "../../src/storage/lcm-identity.js";
import { LcmLedger } from "../../src/storage/lcm-ledger.js";

const roots: string[] = [];
const make = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-directory-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const canonical = (directory: string): string =>
  canonicalProjectIdentity({ liveCwd: directory }).canonicalPath ?? directory;

const identity = (directory: string, key: string): ProjectIdentity => {
  const canonicalPath = canonical(directory);
  return { version: 1, key, canonicalPath, aliases: [canonicalPath] };
};

const DAY = 24 * 60 * 60 * 1_000;

describe("LCM ledger directory", () => {
  it("keeps a project on its first key after the directory inode changes", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project, { recursive: true });
    const first = identity(project, "v1:devino:10:100");
    const moved = identity(project, "v1:devino:10:200");

    expect(stableProjectKey(ledgers, first)).toBe(first.key);
    fs.writeFileSync(defaultLedgerPath(ledgers, first.key), "");

    expect(stableProjectKey(ledgers, moved)).toBe(first.key);
  });

  it("files a new project under its own key when no ledger was kept", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project, { recursive: true });
    stableProjectKey(ledgers, identity(project, "v1:devino:10:100"));
    const moved = identity(project, "v1:devino:10:200");

    expect(stableProjectKey(ledgers, moved)).toBe(moved.key);
  });

  it("opens the ledger a project was first filed under", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project);
    const filed = "v1:devino:10:100";
    stableProjectKey(ledgers, identity(project, filed));
    const seeded = new LcmLedger({ rootDir: ledgers, projectKey: filed, project: { liveCwd: project } });
    seeded.appendRaw({
      projectKey: filed,
      sessionId: "session-1",
      entryId: "e1",
      role: "user",
      content: "hello",
      payloadJson: JSON.stringify({ type: "message", id: "e1" }),
    });
    seeded.close();

    const opened = new LcmLedger({ rootDir: ledgers, project: { liveCwd: project } });

    expect(canonicalProjectIdentity({ liveCwd: project }).key).not.toBe(filed);
    expect(opened.project.key).toBe(filed);
    expect(opened.readRaw(filed)).toHaveLength(1);
    opened.close();
  });

  it("removes an abandoned ledger and keeps live and active ones", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const gone = path.join(base, "gone");
    const live = path.join(base, "live");
    const active = path.join(base, "active");
    for (const directory of [gone, live, active]) fs.mkdirSync(directory);
    const canonicalGone = canonical(gone);
    const keys = [gone, live, active].map((directory) =>
      stableProjectKey(ledgers, canonicalProjectIdentity({ liveCwd: directory }), Date.now() - 90 * DAY),
    );
    for (const key of keys) fs.writeFileSync(defaultLedgerPath(ledgers, key), "x");
    const old = new Date(Date.now() - 90 * DAY);
    for (const key of keys) fs.utimesSync(defaultLedgerPath(ledgers, key), old, old);
    fs.rmSync(gone, { recursive: true, force: true });

    const result = sweepLedgers(ledgers, { keepKey: keys[2]!, force: true });

    expect(result.removed).toEqual([canonicalGone]);
    expect(fs.existsSync(defaultLedgerPath(ledgers, keys[0]!))).toBe(false);
    expect(fs.existsSync(defaultLedgerPath(ledgers, keys[1]!))).toBe(true);
    expect(fs.existsSync(defaultLedgerPath(ledgers, keys[2]!))).toBe(true);
  });

  it("keeps a recently written ledger whose project is gone", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project);
    const key = stableProjectKey(ledgers, canonicalProjectIdentity({ liveCwd: project }));
    fs.writeFileSync(defaultLedgerPath(ledgers, key), "x");
    fs.rmSync(project, { recursive: true, force: true });

    expect(sweepLedgers(ledgers, { keepKey: "other", force: true }).removed).toEqual([]);
    expect(fs.existsSync(defaultLedgerPath(ledgers, key))).toBe(true);
  });

  it("sweeps at most once a day", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    fs.mkdirSync(ledgers, { recursive: true });

    expect(sweepLedgers(ledgers, { keepKey: "active", force: true }).skipped).toBe(false);
    expect(sweepLedgers(ledgers, { keepKey: "active" }).skipped).toBe(true);
  });

  it("keeps the active project's ledger even when its directory is gone", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "active");
    fs.mkdirSync(project);
    const key = stableProjectKey(ledgers, identity(project, "v1:devino:10:100"), Date.now() - 90 * DAY);
    fs.writeFileSync(defaultLedgerPath(ledgers, key), "x");
    const old = new Date(Date.now() - 90 * DAY);
    fs.utimesSync(defaultLedgerPath(ledgers, key), old, old);
    fs.rmSync(project, { recursive: true, force: true });

    expect(sweepLedgers(ledgers, { keepKey: key, force: true }).removed).toEqual([]);
    expect(fs.existsSync(defaultLedgerPath(ledgers, key))).toBe(true);
  });
});
