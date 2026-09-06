import { describe, expect, it } from "vitest";
import { buildDynamicGuestDeclarations } from "../src/runtime/dynamic-guest-types.js";
import { GUEST_TYPE_DECLARATIONS, guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { sanitizeMcpRefPart } from "../src/ref-names.js";

describe("buildDynamicGuestDeclarations", () => {
  const githubServer = {
    server: "github",
    tools: [
      {
        name: "get_repo",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
          },
          required: ["owner", "repo"],
          additionalProperties: false,
        },
      },
      {
        name: "search_repositories",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sort: { enum: ["stars", "updated"] },
            page: { type: "integer" },
          },
          required: ["query"],
        },
      },
    ],
  };

  it("returns no replacements for empty sources, preserving the loose surface", () => {
    expect(buildDynamicGuestDeclarations({})).toEqual({});
    expect(buildDynamicGuestDeclarations({ mcpServers: [] })).toEqual({});
    expect(buildDynamicGuestDeclarations({ extensionTools: [] })).toEqual({});
    const declarations = guestTypeDeclarations(true, {
      dynamic: buildDynamicGuestDeclarations({}),
    });
    expect(declarations).toContain("declare const mcp: FabricMcpApi;");
    expect(declarations).toContain("declare const extensions: FabricExtensionsApi;");
  });

  it("renders required props, enums, and strict object shapes for mcp tools", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    expect(dynamic.mcp).toBeDefined();
    expect(dynamic.mcp).toContain("interface FabricMcpServer_github {");
    expect(dynamic.mcp).toContain(
      'get_repo(args: { owner: string; repo: string }): Promise<FabricMcpResult | unknown>;',
    );
    expect(dynamic.mcp).toContain("sort?: \"stars\" | \"updated\";");
    expect(dynamic.mcp).toContain("page?: number;");
    expect(dynamic.mcp).toContain("} & FabricMcpManagement;");
    expect(dynamic.extensions).toBeUndefined();
  });

  it("keeps the open-object index signature when additionalProperties is not false", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    // search_repositories is open: unexpected extra keys still compile.
    const open = typeCheckFabricCode(
      'await mcp.github.search_repositories({ query: "q", anything: 1 }); return "ok";',
      declarations,
    );
    expect(open.errors).toEqual([]);
  });

  it("fails type-check on arity violations for typed mcp tools", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    const arity = typeCheckFabricCode(
      'await mcp.github.get_repo(); return "never";',
      declarations,
    );
    expect(arity.errors.length).toBeGreaterThan(0);
    expect(arity.errors.map((error) => error.message).join(" ")).toMatch(
      /Expected 1 arguments/,
    );
    // A missing required property alone is TS2345 — suppressed by the checker's
    // deliberate coercion policy (same as omp.* tools) — and is instead caught
    // by the registry's validate stage, covered by the execution-service tests.
    const omittedProp = typeCheckFabricCode(
      'await mcp.github.get_repo({ owner: "octo" }); return "compiles";',
      declarations,
    );
    expect(omittedProp.errors).toEqual([]);
  });

  it("fails type-check on unexpected keys for closed mcp tool schemas", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    const extra = typeCheckFabricCode(
      'await mcp.github.get_repo({ owner: "o", repo: "r", branchs: "main" }); return "never";',
      declarations,
    );
    expect(extra.errors.length).toBeGreaterThan(0);
    expect(extra.errors.map((error) => error.message).join(" ")).toMatch(
      /branchs|known properties/,
    );
  });

  it("accepts correctly-shaped mcp calls and keeps management verbs typed", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    const ok = typeCheckFabricCode(
      `
const repo = await mcp.github.get_repo({ owner: "octo", repo: "hello" });
const servers = await mcp.servers();
const one = servers[0]?.transport;
await mcp.call({ server: "github", tool: "get_repo", args: { owner: "o", repo: "r" } });
return { repo, one };
`,
      declarations,
    );
    expect(ok.errors).toEqual([]);
  });

  it("leaves unknown servers and tools as runtime-resolved calls", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    // Unknown server/tool names are property-miss diagnostics, suppressed by
    // design — they resolve or reject at dispatch exactly like the loose
    // declarations before this feature.
    const cold = typeCheckFabricCode(
      'const a = await mcp.some_new_server.tool({ anyShape: 1 }); const b = await mcp.github.brand_new_tool({}); return { a, b };',
      declarations,
    );
    expect(cold.errors).toEqual([]);
  });

  it("emits the sanitized identifier plus quoted raw alias for non-identifier names", () => {
    const dynamic = buildDynamicGuestDeclarations({
      mcpServers: [
        {
          server: "my-server",
          tools: [
            {
              name: "do-thing",
              inputSchema: {
                type: "object",
                properties: { q: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    });
    expect(dynamic.mcp).toContain(`  my_server: FabricMcpServer_my_server;`);
    expect(dynamic.mcp).toContain(`  "my-server": FabricMcpServer_my_server;`);
    expect(dynamic.mcp).toContain("  do_thing(args?: { q?: string })");
    expect(dynamic.mcp).toContain('  "do-thing"(args?: { q?: string })');
    const declarations = guestTypeDeclarations(true, { dynamic });
    const viaSanitized = typeCheckFabricCode(
      'await mcp.my_server.do_thing({ q: "x" }); return "ok";',
      declarations,
    );
    expect(viaSanitized.errors).toEqual([]);
    const viaRaw = typeCheckFabricCode(
      'await mcp["my-server"]["do-thing"]({}); return "ok";',
      declarations,
    );
    expect(viaRaw.errors).toEqual([]);
    const badShape = typeCheckFabricCode(
      'await mcp.my_server.do_thing({ q: "x", junk: 1 }); return "never";',
      declarations,
    );
    expect(badShape.errors.length).toBeGreaterThan(0);
  });

  it("drops servers whose sanitized names collide, mirroring runtime ambiguity", () => {
    const tool = {
      name: "ping",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    };
    const dynamic = buildDynamicGuestDeclarations({
      mcpServers: [
        { server: "a-b", tools: [tool] },
        { server: "a_b", tools: [tool] },
      ],
    });
    expect(dynamic.mcp).toBeDefined();
    expect(dynamic.mcp).not.toContain("FabricMcpServer_a_b {");
    expect(dynamic.mcp).toContain("2 server(s) untyped");
    expect(dynamic.mcp).not.toContain("  a_b: ");
  });

  it("mirrors the shared sanitizer for member paths", () => {
    expect(sanitizeMcpRefPart("my-server")).toBe("my_server");
    expect(sanitizeMcpRefPart("9tools")).toBe("_9tools");
    const dynamic = buildDynamicGuestDeclarations({
      mcpServers: [
        {
          server: "9tools",
          tools: [
            { name: "x", inputSchema: { type: "object", additionalProperties: true } },
          ],
        },
      ],
    });
    expect(dynamic.mcp).toContain("  _9tools: FabricMcpServer__9tools;");
  });

  it("falls back to a loose signature when the schema exceeds size caps", () => {
    const huge = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `property_${index}_with_a_very_long_name_to_burn_budget`,
          { type: "string" },
        ]),
      ),
    };
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [{ name: "big_tool", inputSchema: huge }],
    });
    expect(dynamic.extensions).toContain(
      "big_tool(args?: Record<string, unknown>): Promise<FabricCapturedToolResult>;",
    );
  });

  it("types extension tools with their captured parameters in full code mode", () => {
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [
        {
          name: "project_status",
          inputSchema: {
            type: "object",
            properties: { verbose: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      ],
    });
    expect(dynamic.extensions).toContain("interface FabricExtensionsApiDynamic {");
    expect(dynamic.extensions).toContain("verbose?: boolean");
    const declarations = guestTypeDeclarations(true, { dynamic });
    expect(declarations).toContain("declare const extensions: FabricExtensionsApiDynamic;");
    const bad = typeCheckFabricCode(
      "await extensions.project_status({ verbise: true }); return 'never';",
      declarations,
    );
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors.map((error) => error.message).join(" ")).toMatch(/verbise|known properties/);
    const good = typeCheckFabricCode(
      "const result = await extensions.project_status({ verbose: true }); return result.text.length;",
      declarations,
    );
    expect(good.errors).toEqual([]);
  });

  it("ignores the extensions replacement in orchestration-only mode", () => {
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [
        {
          name: "project_status",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    const declarations = guestTypeDeclarations(false, { dynamic });
    expect(declarations).not.toContain("FabricExtensionsApiDynamic");
    expect(declarations).not.toContain("declare const extensions:");
  });

  it("still applies the mcp replacement in orchestration-only mode", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(false, { dynamic });
    expect(declarations).toContain("} & FabricMcpManagement;");
    expect(declarations).not.toContain("declare const mcp: FabricMcpApi;");
  });

  it("keeps the loose surface when the mcp global is excluded", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, {
      excludeGlobals: ["mcp"],
      dynamic,
    });
    expect(declarations).not.toContain("FabricMcpServer_github");
    expect(declarations).not.toContain("declare const mcp:");
  });

  it("supports union, array, tuple, and const schema forms", () => {
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [
        {
          name: "mixed",
          inputSchema: {
            type: "object",
            properties: {
              mode: { anyOf: [{ const: "fast" }, { const: "slow" }] },
              tags: { type: "array", items: { type: "string" } },
              pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
              maybe: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
      ],
    });
    expect(dynamic.extensions).toContain('mode?: "fast" | "slow"');
    expect(dynamic.extensions).toContain("tags?: Array<string>");
    expect(dynamic.extensions).toContain("pair?: [string, number]");
    expect(dynamic.extensions).toContain("maybe?: string | null");
    const declarations = guestTypeDeclarations(true, { dynamic });
    const ok = typeCheckFabricCode(
      'await extensions.mixed({ mode: "fast", tags: ["a"], pair: ["x", 1], maybe: null }); return "ok";',
      declarations,
    );
    expect(ok.errors).toEqual([]);
  });

  it("leaves the static declarations untouched when no dynamic option is given", () => {
    expect(guestTypeDeclarations(true)).toBe(GUEST_TYPE_DECLARATIONS);
  });
});
