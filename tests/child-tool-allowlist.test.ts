import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { readChildToolAllowlist } from "../src/core/child-tool-allowlist.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { OmpToolsProvider } from "../src/providers/omp-tools-provider.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context = { cwd: process.cwd(), signal: new AbortController().signal } as FabricInvocationContext;
afterEach(() => vi.unstubAllEnvs());

describe("child optional tool allowlist", () => {
  it("leaves the host unrestricted and fails closed for malformed inherited authority", () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", undefined);
    expect(readChildToolAllowlist()).toBeUndefined();
    for (const value of ["", "null", "{}", "not json", '["read", 1]']) {
      expect([...readChildToolAllowlist(value)!]).toEqual([]);
    }
    expect([...readChildToolAllowlist('["read", "fabric_exec"]')!]).toEqual(["read"]);
  });

  it("filters discovery and blocks preparation and execution before any side effect", async () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", '["read", "fabric_exec"]');
    const provider = await OmpToolsProvider.create(process.cwd());
    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual(["read"]);
    expect(await provider.describe("bash", context)).toBeUndefined();
    expect(() => provider.prepareArguments("edit", { path: "must-not-read", oldText: "x", newText: "y", all: true })).toThrow(/allowlist/);
    await expect(provider.invoke("bash", { command: "must-not-execute" }, context)).rejects.toThrow(/allowlist/);
    // Permissions are frozen when the provider is created, not ambient mutable policy.
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", '["bash"]');
    expect(await provider.describe("read", context)).toBeDefined();
    expect(await provider.describe("bash", context)).toBeUndefined();
  });

  it("cannot bypass the allowlist through the captured-tool namespace", async () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", '["read", "fabric_exec"]');
    const catalog = new CapturedToolCatalog();
    const entry = { name: "bash", definition: { description: "shell", parameters: {} }, sourceInfo: { path: "/extension/index.ts" }, risk: "execute" };
    const list = vi.spyOn(catalog, "list").mockReturnValue([entry] as never);
    const get = vi.spyOn(catalog, "get").mockReturnValue(entry as never);
    const require = vi.spyOn(catalog, "require");
    const provider = new CapturedToolsProvider(catalog);
    expect(await provider.list({}, context)).toEqual([]);
    expect(await provider.describe("bash", context)).toBeUndefined();
    expect(() => provider.prepareArguments("bash", {})).toThrow(/allowlist/);
    await expect(provider.invoke("bash", {}, context)).rejects.toThrow(/allowlist/);
    expect(require).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });

  it("denies a core tool OMP itself has turned off", async () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", undefined);
    const provider = await OmpToolsProvider.create(
      process.cwd(),
      undefined,
      undefined,
      () => new Set(["grep", "glob"]),
    );
    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual(["grep", "find"]);
    expect(await provider.describe("read", context)).toBeUndefined();
    expect(await provider.describe("grep", context)).toBeDefined();
    expect(() => provider.prepareArguments("read", { path: "test.txt" })).toThrow(/OMP's active tool selection/);
    await expect(provider.invoke("bash", { command: "echo test" }, context))
      .rejects.toThrow(/OMP's active tool selection/);
  });

  it("follows the host selection as it changes and reads an empty set as unknown", async () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", undefined);
    let hostActive = new Set(["read"]);
    const provider = await OmpToolsProvider.create(process.cwd(), undefined, undefined, () => hostActive);
    expect(await provider.describe("bash", context)).toBeUndefined();

    hostActive = new Set(["read", "bash"]);
    expect(await provider.describe("bash", context)).toBeDefined();

    hostActive = new Set();
    expect(await provider.describe("bash", context)).toBeDefined();
  });

  it("refuses a denied call instead of repairing it into a sibling tool", async () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", undefined);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-denied-repair-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "TODO here\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(await OmpToolsProvider.create(
        cwd,
        undefined,
        undefined,
        () => new Set(["read", "find", "ls"]),
      ));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.fullCodeMode = true;
      config.approvals.read = "allow";
      const result = await new FabricExecutionService(registry, config).execute({
        code: 'return await omp.grep({ pattern: "TODO", path: "." });',
        signal: undefined,
        parentToolCallId: "denied-repair",
        context: { cwd, hasUI: false } as ExtensionContext,
        onPartial() {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("OMP tool grep is not permitted by OMP's active tool selection");
      expect(result.audits.map((audit) => audit.ref)).not.toContain("omp.find");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("intersects the child allowlist with the host selection", async () => {
    vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", '["read", "bash"]');
    const provider = await OmpToolsProvider.create(
      process.cwd(),
      undefined,
      undefined,
      () => new Set(["read", "grep"]),
    );
    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual(["read"]);
    expect(() => provider.prepareArguments("grep", { pattern: "x" })).toThrow(/child's tool allowlist/);
    await expect(provider.invoke("bash", { command: "echo test" }, context))
      .rejects.toThrow(/OMP's active tool selection/);
  });
});
