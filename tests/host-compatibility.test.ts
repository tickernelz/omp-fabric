import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  detectOmpHostVersion,
  MINIMUM_OMP_HOST_VERSION,
  ompHostCompatibilityWarning,
} from "../src/host-compatibility.js";

const roots: string[] = [];

const fakeHost = (version: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-host-version-"));
  roots.push(root);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }),
  );
  const cli = path.join(dist, "cli.js");
  fs.writeFileSync(cli, "");
  return cli;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OMP host compatibility", () => {
  it("compares release and prerelease versions", () => {
    expect(compareVersions("18.2.9", MINIMUM_OMP_HOST_VERSION)).toBeLessThan(0);
    expect(compareVersions("18.3.0", MINIMUM_OMP_HOST_VERSION)).toBe(0);
    expect(compareVersions("18.3.1", MINIMUM_OMP_HOST_VERSION)).toBeGreaterThan(0);
    expect(compareVersions("18.3.0-beta.1", MINIMUM_OMP_HOST_VERSION)).toBeLessThan(0);
    expect(compareVersions("invalid", MINIMUM_OMP_HOST_VERSION)).toBeUndefined();
  });

  it("detects the host package from the CLI path", () => {
    expect(detectOmpHostVersion(fakeHost("18.3.1"))).toBe("18.3.1");
    expect(detectOmpHostVersion("/does/not/exist")).toBeUndefined();
  });

  it("warns only for a detected unsupported host", () => {
    expect(ompHostCompatibilityWarning("18.2.6")).toContain("requires OMP >= 18.3.0");
    expect(ompHostCompatibilityWarning("18.3.0")).toBeUndefined();
    expect(ompHostCompatibilityWarning(undefined)).toBeUndefined();
  });
});
