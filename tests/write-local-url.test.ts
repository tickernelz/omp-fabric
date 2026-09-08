import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings, type ToolSession } from "@oh-my-pi/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { createPreviewWriteToolDefinition } from "../src/providers/write-preview.js";
import { OmpToolsProvider, setOmpSessionIdentity } from "../src/providers/omp-tools-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-local-write-"));
  roots.push(dir);
  return dir;
};

const sessionAt = (cwd: string): ToolSession =>
  ({
    cwd,
    hasUI: false,
    hasEditTool: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    settings: Settings.isolated({}),
  }) as unknown as ToolSession;

const entriesUnder = (dir: string): string[] => {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return found.sort();
};

describe("omp.write internal URLs", () => {
  it("routes a local:// write to the host resolver, never a literal directory", async () => {
    const cwd = scratch();
    const definition = createPreviewWriteToolDefinition(cwd, sessionAt(cwd));
    const name = `fabric-local-${Date.now()}.md`;

    const result = await definition.execute(
      "call-local",
      { path: `local://${name}`, content: "payload" } as never,
      undefined as never,
      (() => {}) as never,
      {} as never,
    ) as { content: Array<{ text: string }> };

    const reported = result.content[0]?.text ?? "";
    expect(reported).toContain("omp-local");
    expect(reported).not.toContain("local:/");
    expect(entriesUnder(cwd)).toEqual([]);

    const resolved = reported.slice(reported.lastIndexOf("/omp-local"));
    const onDisk = path.join(os.tmpdir(), resolved.replace(/^\//, ""));
    expect(fs.readFileSync(onDisk, "utf8")).toBe("payload");
    fs.rmSync(onDisk, { force: true });
  });

  it("keeps an ordinary relative write on the filesystem path", async () => {
    const cwd = scratch();
    const definition = createPreviewWriteToolDefinition(cwd, sessionAt(cwd));

    await definition.execute(
      "call-plain",
      { path: "./notes/plain.md", content: "hello" } as never,
      undefined as never,
      (() => {}) as never,
      {} as never,
    );

    expect(entriesUnder(cwd)).toEqual([path.join("notes", "plain.md")]);
  });
});

describe("local:// root follows the host session", () => {
  it("writes under the artifacts dir the host read resolver uses", async () => {
    const cwd = scratch();
    const artifacts = scratch();
    const sessionId = `unit-${process.pid}-${Date.now()}`;
    setOmpSessionIdentity({
      getSessionId: () => sessionId,
      getArtifactsDir: () => artifacts,
      getSessionFile: () => null,
    });
    try {
      const provider = await OmpToolsProvider.create(cwd);
      const context = {
        cwd,
        signal: undefined,
        parentToolCallId: "t",
        nestedToolCallId: "n",
        extensionContext: {} as never,
        update() {},
        activity() {},
      } as unknown as FabricInvocationContext;

      await provider.invoke(
        "write",
        { path: "local://scoped.md", content: "scoped" },
        context,
      );
      expect(fs.readFileSync(path.join(artifacts, "local", "scoped.md"), "utf8")).toBe("scoped");
      expect(fs.existsSync(path.join(os.tmpdir(), "omp-local", sessionId))).toBe(false);

      expect(entriesUnder(cwd)).toEqual([]);
    } finally {
      setOmpSessionIdentity(undefined);
    }
  });
});
