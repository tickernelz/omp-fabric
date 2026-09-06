import { sanitizeMcpRefPart } from "../ref-names.js";
import type {
  FabricDynamicGuestDeclarations,
  FabricGuestTypeSources,
  FabricNamedActionTypeSource,
} from "../protocol.js";

// Renders guest .d.ts fragments for the dynamic call surfaces
// (mcp.<server>.<tool> and extensions.<tool>) from live provider descriptors,
// closing the type-check gap those globals had as Record<string, unknown>
// callables: argument-shape mistakes surfaced only at dispatch time. The
// generated surface stays advisory — the registry still validates every
// call's args against the action's own inputSchema before invoke, so drift
// between these declarations and a live server fails at the usual validate
// stage rather than silently.

const MAX_DEPTH = 6;
const MAX_UNION_MEMBERS = 12;
const MAX_SCHEMA_SOURCE_CHARS = 4_096;
const MAX_MEMBER_TYPE_CHARS = 2_500;
const MAX_SECTION_CHARS = 60_000;
const MAX_MCP_SERVERS = 64;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_EXTENSION_TOOLS = 256;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertyKey = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

const literalType = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "unknown";
};

const unionType = (parts: string[]): string => {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return "unknown";
  return unique.length === 1 ? unique[0]! : unique.join(" | ");
};

const typeList = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
};

const objectType = (schema: Record<string, unknown>, depth: number): string => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const members: string[] = [];
  for (const key of Object.keys(properties).sort()) {
    members.push(
      `${propertyKey(key)}${required.has(key) ? "" : "?"}: ${schemaType(properties[key], depth + 1)}`,
    );
  }
  const additional = schema.additionalProperties;
  if (additional !== false) {
    members.push(
      isRecord(additional)
        ? `[key: string]: ${schemaType(additional, depth + 1)}`
        : "[key: string]: unknown",
    );
  }
  return `{ ${members.join("; ")} }`;
};

const schemaType = (schema: unknown, depth: number): string => {
  if (depth > MAX_DEPTH) return "unknown";
  if (schema === true || schema === undefined) return "unknown";
  if (schema === false) return "never";
  if (!isRecord(schema)) return "unknown";
  if ("const" in schema) return literalType(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return unionType(schema.enum.slice(0, MAX_UNION_MEMBERS).map(literalType));
  }
  const alternates = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (alternates) {
    if (alternates.length === 0) return "unknown";
    return unionType(
      alternates.slice(0, MAX_UNION_MEMBERS).map((entry) => schemaType(entry, depth + 1)),
    );
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf
      .slice(0, MAX_UNION_MEMBERS)
      .map((entry) => {
        const rendered = schemaType(entry, depth + 1);
        return rendered.includes(" | ") ? `(${rendered})` : rendered;
      })
      .join(" & ");
  }
  const types = typeList(schema.type);
  if (types.length > 1) {
    return unionType(types.map((type) => schemaType({ ...schema, type }, depth + 1)));
  }
  const type = types[0];
  if (type === "object" || (!type && isRecord(schema.properties))) {
    return objectType(schema, depth);
  }
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") {
    const items = schema.items;
    if (Array.isArray(items)) {
      return `[${items
        .slice(0, MAX_UNION_MEMBERS)
        .map((entry) => schemaType(entry, depth + 1))
        .join(", ")}]`;
    }
    return isRecord(items) || items === true
      ? `Array<${schemaType(items, depth + 1)}>`
      : "unknown[]";
  }
  return "unknown";
};

interface FabricRenderBudget {
  chars: number;
}

const spend = (budget: FabricRenderBudget, text: string): boolean => {
  if (budget.chars < text.length) return false;
  budget.chars -= text.length;
  return true;
};

const hasRequiredArgs = (source: FabricNamedActionTypeSource): boolean =>
  Array.isArray(source.inputSchema.required) &&
  source.inputSchema.required.length > 0 &&
  isRecord(source.inputSchema.properties);

const renderMember = (
  name: string,
  source: FabricNamedActionTypeSource,
  resultType: string,
): string => {
  const loose = `${propertyKey(name)}(args?: Record<string, unknown>): ${resultType};`;
  const schemaJson = JSON.stringify(source.inputSchema);
  if (!schemaJson || schemaJson.length > MAX_SCHEMA_SOURCE_CHARS) return loose;
  const rendered = schemaType(source.inputSchema, 0);
  if (rendered.length > MAX_MEMBER_TYPE_CHARS) return loose;
  return `${propertyKey(name)}(args${hasRequiredArgs(source) ? "" : "?"}: ${rendered}): ${resultType};`;
};

// Name collisions after sanitization are ambiguous: the MCP provider refuses
// ambiguous sanitized server names and resolves colliding tools to the first
// match, so mirrored members would promise a shape dispatch does not
// guarantee. Unique names render in up to two forms — the sanitized
// identifier the model types and a quoted raw alias for bracket access
// (mcp["my-server"]) — and ambiguous groups render nothing. A raw alias can
// never collide with a sanitized member: aliases always contain a character
// the sanitizer would replace or a leading digit it would prefix.
const renderMemberBlock = (
  sources: FabricNamedActionTypeSource[],
  resultType: string,
  limit: number,
  budget: FabricRenderBudget,
): { lines: string[]; dropped: number } => {
  const bySanitized = new Map<string, FabricNamedActionTypeSource[]>();
  for (const source of sources.slice(0, limit)) {
    const key = sanitizeMcpRefPart(source.name);
    const group = bySanitized.get(key);
    if (group) group.push(source);
    else bySanitized.set(key, [source]);
  }
  const lines: string[] = [];
  let dropped = Math.max(0, sources.length - limit);
  const sortedGroups = [...bySanitized.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [sanitized, group] of sortedGroups) {
    if (group.length > 1) {
      dropped += group.length;
      continue;
    }
    const source = group[0]!;
    const text =
      source.name === sanitized
        ? `  ${renderMember(sanitized, source, resultType)}`
        : `  ${renderMember(sanitized, source, resultType)}\n  ${renderMember(source.name, source, resultType)}`;
    if (!spend(budget, text)) {
      dropped += 1;
      continue;
    }
    lines.push(text);
  }
  return { lines, dropped };
};

const renderMcpDeclaration = (
  sources: NonNullable<FabricGuestTypeSources["mcpServers"]>,
): string => {
  const bySanitized = new Map<string, typeof sources>();
  const rawNames = new Set<string>();
  for (const source of sources.slice(0, MAX_MCP_SERVERS)) {
    if (rawNames.has(source.server)) continue;
    rawNames.add(source.server);
    const key = sanitizeMcpRefPart(source.server);
    const group = bySanitized.get(key);
    if (group) group.push(source);
    else bySanitized.set(key, [source]);
  }
  const budget: FabricRenderBudget = { chars: MAX_SECTION_CHARS };
  const interfaces: string[] = [];
  const mapEntries: string[] = [];
  let droppedServers = Math.max(0, sources.length - rawNames.size);
  let droppedTools = 0;
  const sortedGroups = [...bySanitized.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [sanitized, group] of sortedGroups) {
    if (group.length > 1) {
      droppedServers += group.length;
      droppedTools += group.reduce((total, entry) => total + entry.tools.length, 0);
      continue;
    }
    const source = group[0]!;
    const interfaceName = `FabricMcpServer_${sanitized}`;
    const memberBlock = renderMemberBlock(
      source.tools,
      "Promise<FabricMcpResult | unknown>",
      MAX_TOOLS_PER_SERVER,
      budget,
    );
    droppedTools += memberBlock.dropped;
    const header = `interface ${interfaceName} {\n${memberBlock.lines.join("\n")}\n}`;
    if (!spend(budget, header)) {
      droppedServers += 1;
      droppedTools += source.tools.length;
      break;
    }
    interfaces.push(header);
    mapEntries.push(`  ${sanitized}: ${interfaceName};`);
    if (source.server !== sanitized) {
      mapEntries.push(`  ${propertyKey(source.server)}: ${interfaceName};`);
    }
  }
  const notes: string[] = [];
  if (droppedServers > 0) notes.push(`${droppedServers} server(s) untyped`);
  if (droppedTools > 0) notes.push(`${droppedTools} tool(s) untyped`);
  const note =
    notes.length > 0
      ? `// Omitted from this surface (${notes.join(", ")}); those calls compile\n// as the loose fallback would and still validate at dispatch.\n`
      : "";
  return (
    "// Generated from the live MCP descriptor cache for this execution. Known\n" +
    "// servers and tools carry their schemas so argument-shape mistakes fail\n" +
    "// type-check before the sandbox runs, like omp.* calls do; anything absent\n" +
    "// (cold cache, ambiguous sanitized names) compiles as it would with the\n" +
    "// loose declarations and is validated by the registry at dispatch.\n" +
    note +
    interfaces.join("\n") +
    (interfaces.length > 0 ? "\n" : "") +
    `declare const mcp: {\n${mapEntries.join("\n")}\n} & FabricMcpManagement;\n`
  );
};

const renderExtensionsDeclaration = (
  sources: NonNullable<FabricGuestTypeSources["extensionTools"]>,
): string => {
  const budget: FabricRenderBudget = { chars: MAX_SECTION_CHARS };
  const memberBlock = renderMemberBlock(
    sources,
    "Promise<FabricCapturedToolResult>",
    MAX_EXTENSION_TOOLS,
    budget,
  );
  const note =
    memberBlock.dropped > 0
      ? `// Omitted ${memberBlock.dropped} tool(s) from this surface; those calls\n// compile as the loose fallback would and still validate at dispatch.\n`
      : "";
  return (
    "// Generated from the captured extension tool catalog for this execution,\n" +
    "// with the same advisory semantics as the generated mcp surface above.\n" +
    note +
    `interface FabricExtensionsApiDynamic {\n${memberBlock.lines.join("\n")}\n}\n` +
    "declare const extensions: FabricExtensionsApiDynamic;\n"
  );
};

// Renders replacement `declare const mcp` / `declare const extensions` blocks
// for guestTypeDeclarations(). Missing or empty sections return undefined so
// the loose static lines survive, matching cold-cache behavior.
export const buildDynamicGuestDeclarations = (
  sources: FabricGuestTypeSources,
): FabricDynamicGuestDeclarations => {
  const dynamic: FabricDynamicGuestDeclarations = {};
  if (sources.mcpServers && sources.mcpServers.length > 0) {
    dynamic.mcp = renderMcpDeclaration(sources.mcpServers);
  }
  if (sources.extensionTools && sources.extensionTools.length > 0) {
    dynamic.extensions = renderExtensionsDeclaration(sources.extensionTools);
  }
  return dynamic;
};
