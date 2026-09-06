import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import type { FabricMcpConfig } from "../src/config.js";
import { McpDescriptorCacheStore } from "../src/providers/mcp-descriptor-cache.js";
import { McpProvider } from "../src/providers/mcp-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const FAKE_SERVER = path.resolve("tests/fixtures/fake-mcp-server.mjs");

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-mcp-cold-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writeConfig = (options: {
  directory: string;
  countFile: string;
  extraArgs?: string[];
}): string => {
  const configPath = path.join(options.directory, "mcporter.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        test: {
          command: process.execPath,
          args: [FAKE_SERVER, ...(options.extraArgs ?? [])],
          env: {
            OMP_FABRIC_MCP_COUNT_FILE: options.countFile,
            OMP_FABRIC_MCP_COUNT_LABEL: "test",
          },
        },
      },
      imports: [],
    }),
  );
  return configPath;
};

const countLines = (countFile: string): string[] =>
  fs.existsSync(countFile)
    ? fs.readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean)
    : [];

const coldConfig = (
  configPath: string,
  cache: Partial<FabricMcpConfig["cache"]> = {},
): FabricMcpConfig => ({
  enabled: true,
  disableOAuth: true,
  allowDynamicServers: true,
  callTimeoutMs: 5_000,
  configPath,
  cache: { enabled: true, revalidate: "changed", revalidateBudgetMs: 10_000, ...cache },
});

const toolNames = (descriptors: { name: string }[]): string[] =>
  descriptors.map((descriptor) => descriptor.name).filter((name) => !name.startsWith("$")).sort();

describe("McpProvider cold discovery", () => {
  it("enumerates server tools on the very first list in a fresh project", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeConfig({ directory, countFile });
    const provider = new McpProvider(directory, coldConfig(configPath), {
      cache: new McpDescriptorCacheStore(path.join(directory, ".omp", "fabric", "mcp-cache.json")),
    });
    try {
      const listed = await provider.list({}, context);
      expect(toolNames(listed)).toContain("test.echo-value");
      expect(provider.listCoverage()).toEqual({ complete: true, reasons: [] });
    } finally {
      await provider.close();
    }
  });

  it("reports the servers it has not enumerated yet instead of a silent empty catalogue", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeConfig({ directory, countFile });
    const provider = new McpProvider(directory, coldConfig(configPath, { revalidateBudgetMs: 1 }), {
      cache: new McpDescriptorCacheStore(path.join(directory, ".omp", "fabric", "mcp-cache.json")),
    });
    try {
      const listed = await provider.list({}, context);
      expect(toolNames(listed)).toEqual([]);
      expect(provider.listCoverage()).toEqual({
        complete: false,
        reasons: ["enumeration_pending", "server_pending:test"],
      });
      await provider.settle();
      expect(provider.listCoverage()).toEqual({ complete: true, reasons: [] });
    } finally {
      await provider.close();
    }
  });

  it("seeds a never-seen project from the global descriptor cache without spawning a server", async () => {
    const first = temporaryDirectory();
    const countFile = path.join(first, "tools-list.log");
    const configPath = writeConfig({ directory: first, countFile });
    const globalPath = path.join(first, "global", "mcp-descriptors.json");
    const warm = new McpProvider(first, coldConfig(configPath), {
      cache: new McpDescriptorCacheStore(path.join(first, ".omp", "fabric", "mcp-cache.json")),
      globalCache: new McpDescriptorCacheStore(globalPath),
    });
    try {
      await warm.list({}, context);
      await warm.settle();
    } finally {
      await warm.close();
    }
    const spawnsAfterFirstProject = countLines(countFile).length;
    expect(spawnsAfterFirstProject).toBeGreaterThan(0);
    expect(fs.existsSync(globalPath)).toBe(true);

    const second = temporaryDirectory();
    const cold = new McpProvider(second, coldConfig(configPath, { revalidate: "off" }), {
      cache: new McpDescriptorCacheStore(path.join(second, ".omp", "fabric", "mcp-cache.json")),
      globalCache: new McpDescriptorCacheStore(globalPath),
    });
    try {
      const listed = await cold.list({}, context);
      expect(toolNames(listed)).toContain("test.echo-value");
      expect(cold.listCoverage()).toEqual({ complete: true, reasons: [] });
      expect(countLines(countFile).length).toBe(spawnsAfterFirstProject);
    } finally {
      await cold.close();
    }
  });

  it("refuses a global seed whose server definition changed", async () => {
    const first = temporaryDirectory();
    const countFile = path.join(first, "tools-list.log");
    const globalPath = path.join(first, "global", "mcp-descriptors.json");
    const warm = new McpProvider(first, coldConfig(writeConfig({ directory: first, countFile })), {
      globalCache: new McpDescriptorCacheStore(globalPath),
    });
    try {
      await warm.list({}, context);
      await warm.settle();
    } finally {
      await warm.close();
    }

    const second = temporaryDirectory();
    const changed = writeConfig({
      directory: second,
      countFile,
      extraArgs: ["--variant=changed"],
    });
    const cold = new McpProvider(second, coldConfig(changed, { revalidate: "off" }), {
      globalCache: new McpDescriptorCacheStore(globalPath),
    });
    try {
      const listed = await cold.list({}, context);
      expect(toolNames(listed)).toEqual([]);
      expect(cold.listCoverage()).toEqual({
        complete: false,
        reasons: ["enumeration_pending", "server_pending:test"],
      });
    } finally {
      await cold.close();
    }
  });
});
