import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectOmpHostVersion, resolveHostVersion } from "../src/host-compatibility.js";

const roots: string[] = [];

const fakeHostPackage = (version: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-host-exec-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }),
  );
  return root;
};

const fakeExecutable = (root: string): string => {
  const executable = path.join(root, "bin", "omp");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "");
  return executable;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveHostVersion", () => {
  it("walks the host package tree from the executable when argv names no real file", async () => {
    const root = fakeHostPackage("18.9.9");
    const bunfsPath = "/$bunfs/root/omp-linux-x64";
    expect(detectOmpHostVersion(bunfsPath)).toBeUndefined();
    const version = await resolveHostVersion({
      argvPath: bunfsPath,
      execPath: fakeExecutable(root),
    });
    expect(version).toBe("18.9.9");
  });

  it("falls through to the host module when neither path names a host package", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-host-"));
    roots.push(bare);
    const version = await resolveHostVersion({
      argvPath: path.join(bare, "cli.js"),
      execPath: path.join(bare, "omp"),
      hostVersion: async () => "18.3.2",
    });
    expect(version).toBe("18.3.2");
  });

  it("prefers the argv path when it does name the host package", async () => {
    const argvRoot = fakeHostPackage("18.4.0");
    const execRoot = fakeHostPackage("18.9.9");
    const version = await resolveHostVersion({
      argvPath: fakeExecutable(argvRoot),
      execPath: fakeExecutable(execRoot),
      hostVersion: async () => "18.3.2",
    });
    expect(version).toBe("18.4.0");
  });

  it("keeps the argv-only detector working for a real package path", () => {
    const root = fakeHostPackage("18.3.1");
    expect(detectOmpHostVersion(fakeExecutable(root))).toBe("18.3.1");
    expect(detectOmpHostVersion("/does/not/exist")).toBeUndefined();
  });

  it("reports nothing when every witness is silent", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-host-"));
    roots.push(bare);
    const version = await resolveHostVersion({
      argvPath: path.join(bare, "cli.js"),
      execPath: undefined,
      hostVersion: async () => undefined,
    });
    expect(version).toBeUndefined();
  });
});
