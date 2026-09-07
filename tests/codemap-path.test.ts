import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { CodemapProvider } from "../src/providers/codemap-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const roots: string[] = [];

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-codemap-path-"));
  roots.push(dir);
  return dir;
};

const contextAt = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
  activity() {},
});

const provider = (): CodemapProvider => new CodemapProvider(DEFAULT_FABRIC_CONFIG.codemap);

const SOURCE = "export const target = 1;\nexport function reachable() { return target; }\n";

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("CodemapProvider path override", () => {
  it("indexes an absolute path outside the session directory", async () => {
    const elsewhere = scratch();
    fs.writeFileSync(path.join(elsewhere, "target.ts"), SOURCE, "utf8");
    const session = scratch();

    const result = await provider().invoke("map", { path: elsewhere, maxTokens: 2_000 }, contextAt(session)) as {
      root: string;
      text: string;
      symbolsShown: number;
    };

    expect(result.root).toBe(elsewhere);
    expect(result.text).toContain("target.ts");
    expect(result.text).toContain("reachable");
    expect(result.symbolsShown).toBeGreaterThan(0);
  });

  it("resolves a relative path against the session directory", async () => {
    const session = scratch();
    fs.mkdirSync(path.join(session, "nested"), { recursive: true });
    fs.writeFileSync(path.join(session, "nested", "target.ts"), SOURCE, "utf8");
    fs.writeFileSync(path.join(session, "outside.ts"), SOURCE, "utf8");

    const result = await provider().invoke("map", { path: "nested", maxTokens: 2_000 }, contextAt(session)) as {
      root: string;
      text: string;
    };

    expect(result.root).toBe(path.resolve(session, "nested"));
    expect(result.text).toContain("target.ts");
    expect(result.text).not.toContain("outside.ts");
  });

  it("defaults to the session directory when no path is given", async () => {
    const session = scratch();
    fs.writeFileSync(path.join(session, "here.ts"), SOURCE, "utf8");

    const result = await provider().invoke("map", { maxTokens: 2_000 }, contextAt(session)) as { root: string };

    expect(result.root).toBe(session);
  });

  it("rejects a path that does not exist and one that is not a directory", async () => {
    const session = scratch();
    const file = path.join(session, "plain.ts");
    fs.writeFileSync(file, SOURCE, "utf8");

    await expect(provider().invoke("map", { path: path.join(session, "absent") }, contextAt(session)))
      .rejects.toThrow(/does not exist/);
    await expect(provider().invoke("map", { path: file }, contextAt(session)))
      .rejects.toThrow(/not a directory/);
    await expect(provider().invoke("map", { path: "   " }, contextAt(session)))
      .rejects.toThrow(/non-empty directory/);
  });

  it("routes cascade through the same override", async () => {
    const session = scratch();
    const elsewhere = scratch();

    const graph = await provider().invoke(
      "cascade",
      { path: elsewhere, seeds: ["whatever.ts"] },
      contextAt(session),
    ) as { unavailable?: string };

    expect(graph.unavailable).toBe("not a git repository");
  });
});
