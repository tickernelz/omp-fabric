import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const fabricExecutionKernelGuidance = (fullCodeMode: boolean): string =>
  [
    fullCodeMode
      ? "OMP Fabric full code mode: `fabric_exec` is the only way to call OMP core tools — use them as `omp.*` inside `code`."
      : "OMP Fabric is in orchestration-only mode. OMP core and registered extension tools stay on their native direct execution path; inside fabric_exec, `omp.*` and `extensions.*` are unavailable.",
    // Files the model has not opened (images in particular) must be read before
    // use; this line rides the turn-stable kernel guidance so provider prefix
    // caches stay warm.
    `Read every file the user provides (images, screenshots, code, text) with the ${fullCodeMode ? "`omp.read`" : "`read`"} tool before responding — never assume its contents.`,
  ].join(" ");

export const defaultFabricExecutionGuidance = (fullCodeMode: boolean): string =>
  fullCodeMode
    ? "Examples and returns: `omp.read('/x')`, `omp.grep('TODO','src')` / `omp.grep({pattern:'TODO', path:'src', ignoreCase:true, context:2})`, `omp.find({pattern:'*.ts', path:'src', limit:20})`, and `omp.ls('src')` return strings; `omp.bash({cmd:'ls'})`, `omp.edit({path:'/x', old:'a', new:'b'})`, and `omp.write({path:'/y', text:'z'})` return `{ok, output, details}` (read `.output`); failed core calls reject, including shell tools on an ordinary nonzero exit; pass `settle: true` to `omp.bash` to get `{ ok: false, exitCode, output, error }` instead. Timeout, cancellation, approval, and security failures still reject.\n`tools` is discovery + generic calls only (`providers`/`catalog`/`list`/`search`/`describe`/`call`/`models`). Call known MCP tools as `mcp.<sanitized_server>.<sanitized_tool>(args)`, captured tools as `extensions.<tool>(args)`, and stable providers as `memory.*`, `state.*`, `schema.*`, or `compact.*`. Use `tools.call({ref,args})` for computed refs. `pi` is the core tools; `omp.<key>` reads named `strings` (not a tool)."
    : "Call known actions through `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `components.*`, `compact.*`, `agents.*`, or `mesh.*`; use `tools.catalog`/`search`/`describe`/`list` for discovery and `tools.call({ref,args})` for computed refs. Other surfaces are opt-in via user-loaded skills.";

// Shape of CapturedToolCatalog entries this renderer needs (kept structural to avoid a runtime dependency on the capture layer from a guidance module).
export interface ExtensionRosterToolSource {
  name: string;
  sourceInfo?: { source?: string; path?: string };
}

// Namespace labels come from the extension package's own identity: the
// package.json `name` nearest the tool's source file, mirroring how pi names
// npm-installed packages. Raw `source` strings are configured specifiers that
// are often full relative paths, so they are only used when no manifest exists.
const manifestNameCache = new Map<string, string | undefined>();

const packageNameFromManifest = (startPath: string | undefined): string | undefined => {
  if (!startPath) return undefined;
  let directory = path.dirname(path.resolve(startPath));
  while (true) {
    if (manifestNameCache.has(directory)) return manifestNameCache.get(directory);
    const manifestPath = path.join(directory, "package.json");
    let name: string | undefined;
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.trim()) name = manifest.name.trim();
      } catch {
        // Unreadable or invalid manifest; keep walking upward.
      }
    }
    manifestNameCache.set(directory, name);
    if (name) return name;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

// In full code mode the model sees only fabric_exec in its tool list, so
// registered extension tools are invisible unless named up front (#69). The
// roster stays names-only: descriptions and schemas are on demand through the
// tools.list/search/describe discovery surface, so the standing prompt cost is
// a bare name index. Core overrides are excluded: they surface as pi.* via
// coreOverridePromptGuidance.
export const extensionToolRosterGuidance = (
  tools: ReadonlyArray<ExtensionRosterToolSource>,
  coreToolNames: ReadonlySet<string>,
): string | undefined => {
  const extensionTools = tools.filter((tool) => !coreToolNames.has(tool.name));
  if (extensionTools.length === 0) return undefined;
  const namespaceLabel = (tool: ExtensionRosterToolSource): string => {
    const source = tool.sourceInfo?.source?.trim();
    if (source?.startsWith("npm:")) return source.slice("npm:".length) || source;
    const manifestName =
      packageNameFromManifest(tool.sourceInfo?.path) ??
      packageNameFromManifest(source && /[\\/]/.test(source) ? source : undefined);
    if (manifestName) return manifestName;
    if (source && !/[\\/]/.test(source)) return source;
    const parts = (tool.sourceInfo?.path ?? source ?? "").split(/[\\/]/).filter(Boolean);
    const base = parts.at(-1)?.trim() ?? "";
    // Entry files like index.js name the package directory, not the source.
    if (/^index\./i.test(base)) return parts.at(-2)?.trim() || base;
    return base || "extensions";
  };
  const groups = new Map<string, string[]>();
  for (const tool of [...extensionTools].sort((left, right) => left.name.localeCompare(right.name))) {
    const label = namespaceLabel(tool);
    const names = groups.get(label);
    if (names) names.push(tool.name);
    else groups.set(label, [tool.name]);
  }
  return [
    "Registered extension tools are callable inside fabric_exec as `extensions.<name>(args)`; run `tools.list` for full descriptions and schemas before re-implementing an effect with omp.bash.",
    ...[...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, names]) => "- " + label + ": " + names.join(", ")),
  ].join("\n");
};

export const fabricSchemaGuidance = (mode: "off" | "audit" | "enforce"): string | undefined => {
  if (mode === "enforce") {
    return "Schema enforce mode is fixed for this session. Reads remain available, but protected-workspace changes must use schema.hypothesize → schema.verify → schema.commit in the same fabric_exec invocation. Direct omp.edit/write/bash, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked by the host gate.";
  }
  if (mode === "audit") {
    return "Schema audit mode reports actions that enforce mode would block, but preserves their current behavior.";
  }
  return undefined;
};
