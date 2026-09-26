import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  OmpToolsProvider,
  setOmpSessionIdentity,
  type OmpSessionIdentity,
} from "../src/providers/omp-tools-provider.js";

const roots: string[] = [];

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-identity-"));
  roots.push(dir);
  return dir;
};

const context = (cwd: string): FabricInvocationContext =>
  ({
    cwd,
    signal: undefined,
    parentToolCallId: "parent",
    nestedToolCallId: "nested",
    extensionContext: {} as never,
    update() {},
  }) as unknown as FabricInvocationContext;

const identityFor = (artifacts: string, sessionId: string): OmpSessionIdentity => ({
  getSessionId: () => sessionId,
  getArtifactsDir: () => artifacts,
  getSessionFile: () => null,
});

afterEach(() => {
  setOmpSessionIdentity(undefined);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OmpToolsProvider session identity", () => {
  it("writes local:// under its own session even after another session claimed the global slot", async () => {
    const parentArtifacts = scratch();
    const childArtifacts = scratch();
    const parent = await OmpToolsProvider.create(
      scratch(),
      undefined,
      undefined,
      undefined,
      identityFor(parentArtifacts, "parent-session"),
    );

    setOmpSessionIdentity(identityFor(childArtifacts, "child-session"));

    await parent.invoke(
      "write",
      { path: "local://owned.md", content: "parent" },
      context(scratch()),
    );

    expect(fs.readFileSync(path.join(parentArtifacts, "local", "owned.md"), "utf8")).toBe("parent");
    expect(fs.existsSync(path.join(childArtifacts, "local", "owned.md"))).toBe(false);
  });

  it("falls back to the global slot when the provider carries no identity", async () => {
    const artifacts = scratch();
    setOmpSessionIdentity(identityFor(artifacts, "global-session"));
    const provider = await OmpToolsProvider.create(scratch());

    await provider.invoke(
      "write",
      { path: "local://global.md", content: "global" },
      context(scratch()),
    );

    expect(fs.readFileSync(path.join(artifacts, "local", "global.md"), "utf8")).toBe("global");
  });
});
