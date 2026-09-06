import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
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
const FLAKY_SERVER = path.resolve("tests/fixtures/flaky-mcp-server.mjs");

const mcpConfig = (overrides: Partial<FabricMcpConfig> = {}): FabricMcpConfig => ({
  enabled: true,
  disableOAuth: true,
  allowDynamicServers: true,
  callTimeoutMs: 5_000,
  cache: { enabled: false, revalidate: "changed", revalidateBudgetMs: 10_000 },
  ...overrides,
});

const cacheConfig = (
  configPath: string,
  cacheOverrides: Partial<FabricMcpConfig["cache"]> = {},
): FabricMcpConfig =>
  mcpConfig({
    configPath,
    cache: { enabled: true, revalidate: "changed", revalidateBudgetMs: 10_000, ...cacheOverrides },
  });

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-mcp-"));
  temporaryDirectories.push(directory);
  return directory;
};

// Two stdio servers backed by the counting fixture. Returns the config path;
// count calls land in countFile with the per-server label.
const writeTwoServerConfig = (options: {
  directory: string;
  countFile: string;
  falExtraArgs?: string[];
}): string => {
  const configPath = path.join(options.directory, "mcporter.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        test: {
          command: process.execPath,
          args: [FAKE_SERVER],
          env: {
            OMP_FABRIC_MCP_COUNT_FILE: options.countFile,
            OMP_FABRIC_MCP_COUNT_LABEL: "test",
          },
        },
        "fal-ai": {
          command: process.execPath,
          args: [FAKE_SERVER, ...(options.falExtraArgs ?? [])],
          env: {
            OMP_FABRIC_MCP_COUNT_FILE: options.countFile,
            OMP_FABRIC_MCP_COUNT_LABEL: "fal-ai",
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

describe("McpProvider", () => {
  it("discovers and calls a stdio server through mcporter", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeTwoServerConfig({ directory, countFile });
    const provider = new McpProvider(directory, mcpConfig({ configPath }));
    try {
      const listed = await provider.list({ namespace: "test" }, context);
      expect(listed).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "test.echo-value", risk: "network" })]),
      );
      const described = await provider.describe("test.echo_value", context);
      expect(described?.inputSchema).toMatchObject({ required: ["value"] });
      await expect(provider.invoke("test.echo_value", { value: "hello" }, context)).resolves.toMatchObject({
        text: "echo:hello",
      });
      await expect(provider.invoke("test.echo_value", { value: "again" }, context)).resolves.toMatchObject({
        text: "echo:again",
      });
      const modelSchema = await provider.describe("fal_ai.get_model_schema", context);
      expect(modelSchema?.name).toBe("fal-ai.get-model-schema");
      await expect(
        provider.invoke(
          "fal_ai.get_model_schema",
          { endpoint_id: "openai/gpt-image-2" },
          context,
        ),
      ).resolves.toMatchObject({ text: "schema:openai/gpt-image-2" });
      const controller = new AbortController();
      const cancelled = provider.invoke(
        "test.echo_value",
        { value: "__delay__" },
        { ...context, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 20);
      await expect(cancelled).rejects.toThrow("MCP call cancelled");

      await expect(
        provider.invoke(
          "$register",
          {
            name: "dynamic-server",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/fake-mcp-server.mjs")],
            env: {
              OMP_FABRIC_MCP_COUNT_FILE: countFile,
              OMP_FABRIC_MCP_COUNT_LABEL: "dynamic-server",
            },
          },
          context,
        ),
      ).resolves.toEqual({ registered: "dynamic-server" });
      await expect(
        provider.invoke("dynamic_server.echo_value", { value: "dynamic" }, context),
      ).resolves.toMatchObject({ text: "echo:dynamic" });
      expect(countLines(countFile).sort()).toEqual([
        "dynamic-server",
        "fal-ai",
        "test",
      ]);
    } finally {
      await provider.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("McpProvider descriptor cache", () => {
  it("populates once, then serves warm sessions without spawning servers", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeTwoServerConfig({ directory, countFile });
    const cachePath = path.join(directory, ".omp", "fabric", "mcp-cache.json");

    const first = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      // Cold cache: the list kicks off background revalidation; nothing is
      // known yet until it drains.
      await first.list({}, context);
      await first.settle();
      const listed = await first.list({}, context);
      expect(listed.map((descriptor) => descriptor.name)).toEqual(
        expect.arrayContaining(["$servers", "test.echo-value", "fal-ai.echo-value"]),
      );
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test"]);
    } finally {
      await first.close();
    }
    expect(fs.existsSync(cachePath)).toBe(true);

    const second = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      // Warm session: hydrated wholly from disk — descriptors and schemas are
      // visible before any server process exists.
      const listed = await second.list({}, context);
      expect(listed.map((descriptor) => descriptor.name)).toEqual(
        expect.arrayContaining([
          "test.echo-value",
          "test.get-model-schema",
          "fal-ai.echo-value",
        ]),
      );
      const described = await second.describe("test.echo_value", context);
      expect(described?.inputSchema).toMatchObject({ required: ["value"] });
      const servers = (await second.invoke("$servers", {}, context)) as Array<{
        name: string;
        tools: number;
        stale: boolean;
      }>;
      expect(servers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "test", tools: 2, stale: false }),
          expect.objectContaining({ name: "fal-ai", tools: 2, stale: false }),
        ]),
      );
      await second.settle();
      // Still only the cold run's two listings — session two spawned nothing.
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test"]);
    } finally {
      await second.close();
    }
  }, 30_000);

  it("ignores whitespace-only config rewrites (definition-hash stability)", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeTwoServerConfig({ directory, countFile });
    const cachePath = path.join(directory, "mcp-cache.json");

    const first = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      await first.list({}, context);
      await first.settle();
    } finally {
      await first.close();
    }
    expect(countLines(countFile).sort()).toEqual(["fal-ai", "test"]);

    // Layer stat changes (mtime/size), but every resolved definition hashes
    // identically: nothing is revalidated.
    fs.appendFileSync(configPath, "\n");

    const second = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      const listed = await second.list({}, context);
      expect(listed.map((descriptor) => descriptor.name)).toEqual(
        expect.arrayContaining(["test.echo-value", "fal-ai.echo-value"]),
      );
      await second.settle();
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test"]);
    } finally {
      await second.close();
    }
  }, 30_000);

  it("revalidates only the server whose definition changed", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    writeTwoServerConfig({ directory, countFile });
    const cachePath = path.join(directory, "mcp-cache.json");
    const configPath = path.join(directory, "mcporter.json");

    const first = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      await first.list({}, context);
      await first.settle();
    } finally {
      await first.close();
    }

    // Only fal-ai's definition changes; test's stays byte-identical.
    writeTwoServerConfig({ directory, countFile, falExtraArgs: ["--v2"] });

    const second = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      // test is served from cache while fal-ai re-lists in the background.
      const listed = await second.list({}, context);
      expect(listed.map((descriptor) => descriptor.name)).toContain("test.echo-value");
      await second.settle();
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "fal-ai", "test"]);
      const after = await second.list({}, context);
      expect(after.map((descriptor) => descriptor.name)).toEqual(
        expect.arrayContaining(["fal-ai.echo-value", "fal-ai.get-model-schema"]),
      );
    } finally {
      await second.close();
    }
  }, 30_000);

  it("revalidate: off never spawns in the background; explicit probes fetch exactly one server", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    writeTwoServerConfig({ directory, countFile });
    const cachePath = path.join(directory, "mcp-cache.json");
    const configPath = path.join(directory, "mcporter.json");

    const first = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      await first.list({}, context);
      await first.settle();
    } finally {
      await first.close();
    }

    writeTwoServerConfig({ directory, countFile, falExtraArgs: ["--v2"] });

    const second = new McpProvider(
      directory,
      cacheConfig(configPath, { revalidate: "off" }),
      { cache: new McpDescriptorCacheStore(cachePath) },
    );
    try {
      const listed = await second.list({}, context);
      await second.settle();
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test"]);
      const names = listed.map((descriptor) => descriptor.name);
      expect(names).toContain("test.echo-value");
      // fal-ai's definition changed, so its cached tools are not served.
      expect(names.some((name) => name.startsWith("fal-ai."))).toBe(false);

      // An explicit namespaced probe is a bounded live fetch of that server.
      const falTools = await second.list({ namespace: "fal_ai" }, context);
      expect(falTools.map((descriptor) => descriptor.name)).toEqual(
        expect.arrayContaining(["fal-ai.echo-value", "fal-ai.get-model-schema"]),
      );
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "fal-ai", "test"]);
      const refreshed = await second.list({}, context);
      expect(refreshed.map((descriptor) => descriptor.name)).toContain("fal-ai.echo-value");
    } finally {
      await second.close();
    }
  }, 30_000);

  it("keeps last-known tools marked stale when revalidation fails", async () => {
    const directory = temporaryDirectory();
    const stateFile = path.join(directory, "flaky-state");
    const configPath = path.join(directory, "mcporter.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          flaky: {
            command: process.execPath,
            args: [FLAKY_SERVER],
            env: { OMP_FABRIC_MCP_FLAKY_STATE: stateFile },
          },
        },
        imports: [],
      }),
    );
    const cachePath = path.join(directory, "mcp-cache.json");

    const first = new McpProvider(
      directory,
      cacheConfig(configPath, { revalidate: "all" }),
      { cache: new McpDescriptorCacheStore(cachePath) },
    );
    try {
      await first.list({}, context);
      await first.settle();
      expect(
        (await first.list({}, context)).map((descriptor) => descriptor.name),
      ).toContain("flaky.flaky-ping");
    } finally {
      await first.close();
    }

    // The fixture now dies at startup: a policy-all revalidation fails, but
    // the cached slice survives and is marked stale.
    const second = new McpProvider(
      directory,
      cacheConfig(configPath, { revalidate: "all" }),
      { cache: new McpDescriptorCacheStore(cachePath) },
    );
    try {
      await second.list({}, context);
      await second.settle();
      const listed = await second.list({}, context);
      expect(listed.map((descriptor) => descriptor.name)).toContain("flaky.flaky-ping");
      const servers = (await second.invoke("$servers", {}, context)) as Array<{
        name: string;
        tools: number;
        stale: boolean;
      }>;
      expect(servers).toEqual([
        expect.objectContaining({ name: "flaky", tools: 1, stale: true }),
      ]);
    } finally {
      await second.close();
    }
  }, 30_000);

  it("lists ephemeral $register servers without persisting them", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeTwoServerConfig({ directory, countFile });
    const cachePath = path.join(directory, "mcp-cache.json");

    const provider = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      await provider.list({}, context);
      await provider.settle();
      await provider.invoke(
        "$register",
        {
          name: "dynamic-server",
          command: process.execPath,
          args: [FAKE_SERVER],
          env: {
            OMP_FABRIC_MCP_COUNT_FILE: countFile,
            OMP_FABRIC_MCP_COUNT_LABEL: "dynamic-server",
          },
        },
        context,
      );
      await provider.settle();
      const names = (await provider.list({}, context)).map((descriptor) => descriptor.name);
      expect(names).toContain("dynamic-server.echo-value");
    } finally {
      await provider.close();
    }
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      servers: Record<string, unknown>;
    };
    expect(Object.keys(cached.servers).sort()).toEqual(["fal-ai", "test"]);
  }, 30_000);

  it("invokes through the cache, reports organic use, and relists on first contact", async () => {
    const directory = temporaryDirectory();
    const countFile = path.join(directory, "tools-list.log");
    const configPath = writeTwoServerConfig({ directory, countFile });
    const cachePath = path.join(directory, "mcp-cache.json");

    const first = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      await first.list({}, context);
      await first.settle();
    } finally {
      await first.close();
    }

    const second = new McpProvider(directory, cacheConfig(configPath), {
      cache: new McpDescriptorCacheStore(cachePath),
    });
    try {
      await second.list({}, context);
      await second.settle();
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test"]);

      const result = (await second.invoke("test.echo_value", { value: "warm" }, context)) as {
        text: string;
      };
      expect(result.text).toBe("echo:warm");
      await second.settle();
      // First contact rode the pooled connection into one background relist.
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test", "test"]);

      // Unknown tools get one forced live relist before the error surfaces.
      await expect(second.invoke("test.nope", {}, context)).rejects.toThrow(
        "Unknown MCP tool",
      );
      expect(countLines(countFile).sort()).toEqual(["fal-ai", "test", "test", "test"]);
    } finally {
      await second.close();
    }
  }, 30_000);
});
