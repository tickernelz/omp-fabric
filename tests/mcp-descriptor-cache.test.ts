import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerDefinition } from "mcporter";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashServerDefinition,
  McpDescriptorCacheStore,
  mcpConfigLayerPaths,
  parseCachedServer,
  sameConfigLayers,
  statConfigLayers,
} from "../src/providers/mcp-descriptor-cache.js";

const temporaryDirectories: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-mcp-cache-"));
  temporaryDirectories.push(directory);
  return directory;
};

const setEnv = (key: string, value: string | undefined): void => {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

// os.homedir() follows $HOME on POSIX: point HOME at a scratch directory so a
// real ~/.mcporter install can never leak into the discovery assertions.
const isolateHome = (): void => {
  setEnv("HOME", temporaryDirectory());
  setEnv("MCPORTER_CONFIG", undefined);
};

describe("mcp config layer discovery", () => {
  it("prefers an explicit configPath over every other layer", () => {
    const directory = temporaryDirectory();
    isolateHome();
    const explicit = path.join(directory, "custom.json");
    expect(mcpConfigLayerPaths(directory, explicit)).toEqual([path.resolve(explicit)]);
  });

  it("honors MCPORTER_CONFIG when no configPath is given", () => {
    const directory = temporaryDirectory();
    isolateHome();
    const explicit = path.join(directory, "env-config.json");
    setEnv("MCPORTER_CONFIG", explicit);
    try {
      expect(mcpConfigLayerPaths(directory)).toEqual([path.resolve(explicit)]);
    } finally {
      setEnv("MCPORTER_CONFIG", undefined);
    }
  });

  it("layers the first existing home config before the project config", () => {
    const directory = temporaryDirectory();
    isolateHome();
    const xdg = temporaryDirectory();
    setEnv("XDG_CONFIG_HOME", xdg);
    const homeConfig = path.join(xdg, "mcporter", "mcporter.json");
    fs.mkdirSync(path.dirname(homeConfig), { recursive: true });
    fs.writeFileSync(homeConfig, "{}");
    const projectConfig = path.join(directory, "config", "mcporter.json");
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.writeFileSync(projectConfig, "{}");
    expect(mcpConfigLayerPaths(directory)).toEqual([homeConfig, projectConfig]);
  });

  it("returns no layers when nothing exists", () => {
    const directory = temporaryDirectory();
    isolateHome();
    setEnv("XDG_CONFIG_HOME", temporaryDirectory());
    expect(mcpConfigLayerPaths(directory)).toEqual([]);
  });
});

describe("config layer fingerprints", () => {
  it("stats every discovered layer", async () => {
    const directory = temporaryDirectory();
    isolateHome();
    setEnv("XDG_CONFIG_HOME", temporaryDirectory());
    const projectConfig = path.join(directory, "config", "mcporter.json");
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.writeFileSync(projectConfig, "{}");
    const stats = await statConfigLayers(directory);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.path).toBe(projectConfig);
    expect(stats[0]?.size).toBe(2);
  });

  it("treats identical stat lists as equal and rejects drift", () => {
    const layer = { path: "/tmp/a.json", mtimeMs: 1_700_000_000_000.5, size: 12 };
    expect(sameConfigLayers([layer], [{ ...layer }])).toBe(true);
    // Sub-millisecond serialization jitter is tolerated.
    expect(
      sameConfigLayers([layer], [{ ...layer, mtimeMs: layer.mtimeMs + 0.4 }]),
    ).toBe(true);
    expect(sameConfigLayers([layer], [{ ...layer, size: 13 }])).toBe(false);
    expect(sameConfigLayers([layer], [{ ...layer, path: "/tmp/b.json" }])).toBe(false);
    expect(sameConfigLayers([layer], [])).toBe(false);
  });
});

describe("server definition hashing", () => {
  it("is stable across key order and URL wrappers", () => {
    const first: ServerDefinition = {
      name: "svc",
      description: "demo",
      command: { kind: "http", url: new URL("http://localhost:9999/mcp") },
    };
    const second: ServerDefinition = {
      command: { kind: "http", url: new URL("http://localhost:9999/mcp") },
      description: "demo",
      name: "svc",
    };
    expect(hashServerDefinition(first)).toBe(hashServerDefinition(second));
    expect(
      hashServerDefinition({
        name: "svc",
        command: { kind: "http", url: new URL("http://localhost:9999/other") },
      }),
    ).not.toBe(hashServerDefinition(first));
  });

  it("changes when stdio arguments change", () => {
    const base: ServerDefinition = {
      name: "svc",
      command: { kind: "stdio", command: "node", args: ["server.mjs"], cwd: "/tmp" },
    };
    const changed: ServerDefinition = {
      name: "svc",
      command: { kind: "stdio", command: "node", args: ["server.mjs", "--v2"], cwd: "/tmp" },
    };
    expect(hashServerDefinition(base)).not.toBe(hashServerDefinition(changed));
  });
});

describe("McpDescriptorCacheStore", () => {
  it("round-trips a cache document", async () => {
    const directory = temporaryDirectory();
    const store = new McpDescriptorCacheStore(path.join(directory, ".omp", "fabric", "mcp-cache.json"));
    const document = {
      version: 1,
      layers: [{ path: "/tmp/config.json", mtimeMs: 123.4, size: 10 }],
      updatedAt: "2024-01-01T00:00:00.000Z",
      servers: {
        svc: {
          definitionHash: "abc",
          transport: "stdio",
          description: null,
          fetchedAt: "2024-01-01T00:00:00.000Z",
          stale: false,
          tools: [{ name: "ping", inputSchema: { type: "object" } }],
        },
      },
    };
    await store.save(document);
    expect(await store.load()).toEqual(document);
  });

  it("returns undefined for missing, corrupt, or wrong-version documents", async () => {
    const directory = temporaryDirectory();
    const store = new McpDescriptorCacheStore(path.join(directory, "mcp-cache.json"));
    expect(await store.load()).toBeUndefined();
    fs.writeFileSync(store.filePath, "not json{");
    expect(await store.load()).toBeUndefined();
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 2, layers: [], servers: {} }));
    expect(await store.load()).toBeUndefined();
  });
});

describe("parseCachedServer", () => {
  it("drops malformed entries without failing the snapshot", () => {
    expect(parseCachedServer(undefined)).toBeUndefined();
    expect(parseCachedServer({ definitionHash: 42, tools: [] })).toBeUndefined();
    expect(parseCachedServer({ definitionHash: "x" })).toBeUndefined();
    const parsed = parseCachedServer({
      definitionHash: "x",
      tools: [{ name: "ok" }, { description: "no name" }],
      stale: 1,
    });
    expect(parsed?.tools.map((tool) => tool.name)).toEqual(["ok"]);
    expect(parsed?.stale).toBe(false);
  });
});
