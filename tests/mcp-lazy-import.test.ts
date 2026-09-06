import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FabricMcpConfig } from "../src/config.js";
import {
  MCP_DESCRIPTOR_CACHE_VERSION,
  McpDescriptorCacheStore,
  statConfigLayers,
} from "../src/providers/mcp-descriptor-cache.js";
import { McpProvider } from "../src/providers/mcp-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const { createRuntime, close } = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock("mcporter", () => ({ createRuntime }));

const invocation: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "outer",
  nestedToolCallId: "inner",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const config = (configPath: string): FabricMcpConfig => ({
  enabled: true,
  configPath,
  disableOAuth: true,
  allowDynamicServers: true,
  callTimeoutMs: 1_000,
  cache: { enabled: true, revalidate: "off", revalidateBudgetMs: 1_000 },
});

beforeEach(() => {
  createRuntime.mockReset();
  close.mockClear();
});

describe("McpProvider lazy mcporter runtime", () => {
  it("hydrates a valid descriptor cache without creating the runtime", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-mcp-lazy-"));
    const configPath = path.join(cwd, "mcporter.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {}, imports: [] }));
    const store = new McpDescriptorCacheStore(path.join(cwd, "cache.json"));
    await store.save({
      version: MCP_DESCRIPTOR_CACHE_VERSION,
      layers: await statConfigLayers(cwd, configPath),
      updatedAt: new Date().toISOString(),
      servers: {
        cached: {
          definitionHash: "hash",
          transport: "stdio",
          description: null,
          fetchedAt: new Date().toISOString(),
          stale: false,
          tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
        },
      },
    });
    const provider = new McpProvider(cwd, config(configPath), { cache: store });

    const listed = await provider.list({}, invocation);

    expect(listed.map((entry) => entry.name)).toContain("cached.echo");
    expect(createRuntime).not.toHaveBeenCalled();
    await provider.close();
  });

  it("single-flights concurrent first live runtime use", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-mcp-live-"));
    const configPath = path.join(cwd, "mcporter.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {}, imports: [] }));
    let release!: () => void;
    createRuntime.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        listServers: () => [],
        getDefinition: vi.fn(),
        close,
      };
    });
    const provider = new McpProvider(cwd, { ...config(configPath), cache: { enabled: false, revalidate: "off", revalidateBudgetMs: 1_000 } });

    const first = provider.invoke("$servers", {}, invocation);
    const second = provider.invoke("$servers", {}, invocation);
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    await provider.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
