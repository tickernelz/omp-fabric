import { statSync } from "node:fs";
import path from "node:path";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { assembleMap } from "../codemap/budget.js";
import { coChange } from "../codemap/cascade.js";
import { buildSymbolIndex } from "../codemap/symbols.js";
import type { CoChangeGraph, SymbolIndex } from "../codemap/types.js";
import type { FabricCodemapConfig } from "../config.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { actionArgNormalizer } from "./arg-normalization.js";

const INDEX_TTL_MS = 30_000;

const pathField = Type.Optional(Type.String({
  maxLength: 4096,
  description:
    "Directory to index. Relative paths resolve against the session directory; defaults to it. Point this at a project root when the session runs elsewhere.",
}));

const mapSchema = Type.Object({
  path: pathField,
  maxTokens: Type.Optional(Type.Number({
    minimum: 200,
    maximum: 200_000,
    description: "Token ceiling for the rendered map",
  })),
  glob: Type.Optional(Type.String({
    maxLength: 512,
    description: "Glob filter relative to the workspace root",
  })),
  focus: Type.Optional(Type.String({
    maxLength: 512,
    description: "Task description or symbol name the map should centre on",
  })),
  seeds: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), {
    maxItems: 32,
    description: "Files whose git co-change history should raise related files in the ranking",
  })),
  refresh: Type.Optional(Type.Boolean({
    description: "Rebuild the symbol index instead of reusing the cached one",
  })),
}, { additionalProperties: false });

const cascadeSchema = Type.Object({
  path: pathField,
  seeds: Type.Array(Type.String({ maxLength: 1024 }), {
    minItems: 1,
    maxItems: 32,
    description: "Files to rank co-change against",
  }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  maxCommits: Type.Optional(Type.Number({ minimum: 10, maximum: 20_000 })),
}, { additionalProperties: false });

interface MapArguments {
  path?: string;
  maxTokens?: number;
  glob?: string;
  focus?: string;
  seeds?: string[];
  refresh?: boolean;
}

interface CascadeArguments {
  path?: string;
  seeds: string[];
  limit?: number;
  maxCommits?: number;
}

const checked = <T>(action: string, schema: { toJsonSchema(): unknown }, args: Record<string, unknown>): T => {
  const validation = validateJsonSchemaValue(schema.toJsonSchema() as Record<string, unknown>, args);
  if (!validation.success) {
    const message = validation.issues.slice(0, 5).map((issue) => issue.message).join("; ");
    throw new Error(`Invalid codemap.${action} arguments: ${message}`);
  }
  return args as T;
};

const resolveRoot = (requested: string | undefined, cwd: string): string => {
  if (requested === undefined) return cwd;
  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid codemap path: expected a non-empty directory");
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`Invalid codemap path: ${resolved} does not exist`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Invalid codemap path: ${resolved} is not a directory`);
  }
  return resolved;
};

const descriptors: FabricActionDescriptor[] = [
  {
    name: "map",
    description:
      "Repo-wide symbol map under an explicit token budget. Returns one line per symbol (line, kind, name) grouped by file, ranked by focus relevance and optional git co-change, with omission counts when the budget bites. Answers which files and symbols a task touches; use omp.grep for text and omp.read for source.",
    inputSchema: mapSchema.toJsonSchema() as unknown as Record<string, unknown>,
    risk: "read",
  },
  {
    name: "cascade",
    description:
      "Rank files by how often they historically changed in the same commits as the seed files, normalised so ubiquitous files (lockfiles, changelogs) do not dominate. Answers which files a change will drag along, which text search cannot.",
    inputSchema: cascadeSchema.toJsonSchema() as unknown as Record<string, unknown>,
    risk: "read",
  },
];

const normalizeCodemapArgs = actionArgNormalizer(() => descriptors);

interface CachedIndex {
  index: SymbolIndex;
  at: number;
}

export class CodemapProvider implements FabricProvider {
  readonly name = "codemap";
  readonly description =
    "Structural repo map: budgeted symbol disclosure and git co-change ranking";

  readonly #cache = new Map<string, CachedIndex>();

  constructor(readonly config: FabricCodemapConfig) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    return normalizeCodemapArgs(actionName, args);
  }

  async #index(root: string, glob: string | undefined, refresh: boolean, signal: AbortSignal | undefined): Promise<SymbolIndex> {
    const key = `${root}\u0000${glob ?? ""}`;
    const cached = this.#cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
    const index = await buildSymbolIndex({
      root,
      ...(glob !== undefined ? { glob } : {}),
      maxFiles: this.config.maxFiles,
      maxSymbols: this.config.maxSymbols,
      ...(signal !== undefined ? { signal } : {}),
    });
    this.#cache.set(key, { index, at: Date.now() });
    return index;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "map": {
        const input = checked<MapArguments>("map", mapSchema, args);
        const target = resolveRoot(input.path, context.cwd);
        const index = await this.#index(target, input.glob, input.refresh === true, context.signal);
        let cascade: CoChangeGraph | undefined;
        if (input.seeds && input.seeds.length > 0) {
          cascade = await coChange({
            root: target,
            seeds: input.seeds,
            maxCommits: this.config.cascadeCommits,
            limit: this.config.cascadeLimit,
          });
        }
        const budgeted = assembleMap({
          index,
          maxTokens: input.maxTokens ?? this.config.defaultMaxTokens,
          ...(input.focus !== undefined ? { focus: input.focus } : {}),
          ...(cascade !== undefined ? { cascade } : {}),
        });
        context.activity?.({
          type: "progress",
          message: `Code map: ${budgeted.symbolsShown} symbols across ${budgeted.filesShown} files${
            budgeted.truncated ? ` (${budgeted.omittedSymbols} omitted)` : ""
          }`,
        });
        return {
          ...budgeted,
          root: index.root,
          indexed: {
            files: index.files.length,
            symbols: index.symbols.length,
            languages: index.languages,
            fallbackFiles: index.fallbackFiles.length,
            truncated: index.truncated,
            elapsedMs: index.elapsedMs,
          },
          ...(cascade !== undefined ? { cascade } : {}),
        };
      }
      case "cascade": {
        const input = checked<CascadeArguments>("cascade", cascadeSchema, args);
        const graph = await coChange({
          root: resolveRoot(input.path, context.cwd),
          seeds: input.seeds,
          maxCommits: input.maxCommits ?? this.config.cascadeCommits,
          limit: input.limit ?? this.config.cascadeLimit,
        });
        context.activity?.({
          type: "progress",
          message: graph.unavailable
            ? `Co-change unavailable: ${graph.unavailable}`
            : `Co-change: ${graph.edges.length} related files from ${graph.commitsScanned} commits`,
        });
        return graph;
      }
      default:
        throw new Error(`Unknown codemap action: ${actionName}`);
    }
  }
}
