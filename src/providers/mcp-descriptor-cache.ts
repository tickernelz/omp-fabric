import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerDefinition } from "mcporter";
import { stableJsonHash } from "../core/stable-hash.js";

export const MCP_DESCRIPTOR_CACHE_VERSION = 1;

export interface McpConfigLayerStat {
  path: string;
  mtimeMs: number;
  size: number;
}

interface CachedMcpToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

interface CachedMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: CachedMcpToolAnnotations;
}

export interface CachedMcpServer {
  definitionHash: string;
  transport: string;
  description: string | null;
  fetchedAt: string;
  stale: boolean;
  tools: CachedMcpTool[];
}

export interface McpDescriptorCacheFile {
  version: number;
  layers: McpConfigLayerStat[];
  updatedAt: string;
  servers: Record<string, CachedMcpServer>;
}

// mcporter merges config from an explicit path (MCP configPath option or the
// MCPORTER_CONFIG env), else a home file plus <rootDir>/config/mcporter.json.
// mcporter's own listConfigLayerPaths is not part of the package's public
// exports map, so the layer discovery is mirrored here exactly; the
// fingerprint below must watch the same files mcporter would read.
const homeDir = (): string => {
  const home = process.env.HOME;
  return home && home.trim().length > 0 ? home : os.homedir();
};

const expandHome = (input: string): string => {
  if (!input.startsWith("~")) return input;
  const home = homeDir();
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
};

const legacyMcporterDir = (): string => path.join(homeDir(), ".mcporter");

const mcporterConfigDir = (): string => {
  const raw = process.env.XDG_CONFIG_HOME;
  if (raw && raw.trim().length > 0) {
    const resolved = expandHome(raw.trim());
    if (path.isAbsolute(resolved)) return path.join(resolved, "mcporter");
  }
  return legacyMcporterDir();
};

const mcporterConfigCandidates = (): string[] => {
  const base = mcporterConfigDir();
  const candidates = [path.join(base, "mcporter.json"), path.join(base, "mcporter.jsonc")];
  const legacy = legacyMcporterDir();
  if (base !== legacy) {
    candidates.push(path.join(legacy, "mcporter.json"), path.join(legacy, "mcporter.jsonc"));
  }
  return candidates;
};

const pathExists = (filePath: string): boolean => {
  try {
    fsSync.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
};

export const mcpConfigLayerPaths = (rootDir: string, configPath?: string): string[] => {
  const explicitRaw = configPath ?? process.env.MCPORTER_CONFIG;
  if (explicitRaw && explicitRaw.trim().length > 0) {
    return [path.resolve(expandHome(explicitRaw.trim()))];
  }
  const paths: string[] = [];
  const home = mcporterConfigCandidates().find(pathExists);
  if (home) paths.push(home);
  const projectPath = path.resolve(rootDir, "config", "mcporter.json");
  if (pathExists(projectPath)) paths.push(projectPath);
  return paths;
};

export const statConfigLayers = async (
  rootDir: string,
  configPath?: string,
): Promise<McpConfigLayerStat[]> => {
  const stats = await Promise.all(
    mcpConfigLayerPaths(rootDir, configPath).map(async (layerPath) => {
      try {
        const stat = await fs.stat(layerPath);
        return { path: layerPath, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // A layer that vanished between discovery and stat simply drops out of
        // the fingerprint, which itself invalidates any cache built with it.
        return undefined;
      }
    }),
  );
  return stats.filter((stat): stat is McpConfigLayerStat => stat !== undefined);
};

// mtimeMs tolerates a millisecond of serialization/format jitter; path order
// is load order, so comparison is positional.
export const sameConfigLayers = (
  left: McpConfigLayerStat[],
  right: McpConfigLayerStat[],
): boolean =>
  left.length === right.length &&
  left.every((layer, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      layer.path === other.path &&
      layer.size === other.size &&
      Math.abs(layer.mtimeMs - other.mtimeMs) <= 1
    );
  });

// Per-server validity key: any edit to a server's merged definition (command,
// args, url, env, headers, …) changes the hash even when its tool list did
// not, while untouched servers keep their cached descriptors across config
// edits elsewhere.
export const hashServerDefinition = (definition: ServerDefinition): string =>
  stableJsonHash(definition);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Lenient per-server validation: garbage entries are dropped rather than
// failing the whole snapshot.
export const parseCachedServer = (value: unknown): CachedMcpServer | undefined => {
  if (!isRecord(value)) return undefined;
  const tools = Array.isArray(value.tools)
    ? value.tools.filter(
        (tool): tool is CachedMcpTool => isRecord(tool) && typeof tool.name === "string",
      )
    : undefined;
  if (typeof value.definitionHash !== "string" || tools === undefined) return undefined;
  return {
    definitionHash: value.definitionHash,
    transport: typeof value.transport === "string" ? value.transport : "unknown",
    description: typeof value.description === "string" ? value.description : null,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
    stale: value.stale === true,
    tools,
  };
};

const parseCacheFile = (value: unknown): McpDescriptorCacheFile | undefined => {
  if (!isRecord(value) || value.version !== MCP_DESCRIPTOR_CACHE_VERSION) return undefined;
  if (!Array.isArray(value.layers) || !isRecord(value.servers)) return undefined;
  const layers = value.layers.filter(
    (layer): layer is McpConfigLayerStat =>
      isRecord(layer) &&
      typeof layer.path === "string" &&
      typeof layer.mtimeMs === "number" &&
      typeof layer.size === "number",
  );
  return {
    version: MCP_DESCRIPTOR_CACHE_VERSION,
    layers,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    servers: value.servers as Record<string, CachedMcpServer>,
  };
};

let tempCounter = 0;

export class McpDescriptorCacheStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<McpDescriptorCacheFile | undefined> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return parseCacheFile(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  // Atomic-ish write: temp file then rename, so a concurrent reader either
  // sees the previous cache or the next one, never a torn document.
  async save(file: McpDescriptorCacheFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.mcp-cache-${process.pid}-${Date.now()}-${tempCounter++}.tmp`,
    );
    await fs.writeFile(tempPath, JSON.stringify(file, null, 2));
    try {
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
