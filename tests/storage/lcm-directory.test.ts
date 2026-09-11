import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableProjectKey, sweepLedgers } from "../../src/storage/lcm-directory.js";
import { canonicalProjectIdentity, defaultLedgerPath } from "../../src/storage/lcm-identity.js";
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

const DAY = 24 * 60 * 60 * 1_000;

describe("LCM ledger directory", () => {
  it("keeps a project on its first key after the directory inode changes", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project);
    const first = canonicalProjectIdentity({ liveCwd: project });
    expect(stableProjectKey(ledgers, first)).toBe(first.key);

    fs.writeFileSync(defaultLedgerPath(ledgers, first.key), "");
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project);
    const second = canonicalProjectIdentity({ liveCwd: project });

    expect(second.key).not.toBe(first.key);
    expect(stableProjectKey(ledgers, second)).toBe(first.key);
  });

  it("files a new project under its own key when no ledger was kept", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project);
    const first = canonicalProjectIdentity({ liveCwd: project });
    stableProjectKey(ledgers, first);

    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project);
    const second = canonicalProjectIdentity({ liveCwd: project });

    expect(stableProjectKey(ledgers, second)).toBe(second.key);
  });

  it("opens the same ledger file for a project whose inode moved", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const project = path.join(base, "project");
    fs.mkdirSync(project);
    const first = new LcmLedger({ rootDir: ledgers, project: { liveCwd: project } });
    first.appendRaw({
      projectKey: first.project.key,
      sessionId: "session-1",
      entryId: "e1",
      role: "user",
      content: "hello",
      payloadJson: JSON.stringify({ type: "message", id: "e1" }),
    });
    const key = first.project.key;
    first.close();

    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(project);
    const second = new LcmLedger({ rootDir: ledgers, project: { liveCwd: project } });

    expect(second.project.key).toBe(key);
    expect(second.readRaw(second.project.key)).toHaveLength(1);
    second.close();
  });

  it("removes an abandoned ledger and keeps live and active ones", () => {
    const base = make();
    const ledgers = path.join(base, "ledgers");
    const gone = path.join(base, "gone");
    const live = path.join(base, "live");
    const active = path.join(base, "active");
    for (const directory of [gone, live, active]) fs.mkdirSync(directory);
    const keys = [gone, live, active].map((directory) =>
      stableProjectKey(ledgers, canonicalProjectIdentity({ liveCwd: directory }), Date.now() - 90 * DAY),
    );
    for (const key of keys) fs.writeFileSync(defaultLedgerPath(ledgers, key), "x");
    const old = new Date(Date.now() - 90 * DAY);
    for (const key of keys) fs.utimesSync(defaultLedgerPath(ledgers, key), old, old);
    fs.rmSync(gone, { recursive: true, force: true });

    const result = sweepLedgers(ledgers, { keepKey: keys[2]!, force: true });

    expect(result.removed).toEqual([gone]);
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
});
