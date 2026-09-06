import {
  type ExtensionContext,
  type ExtensionRunner,
  type RegisteredTool,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/omptype/typebox";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { OmpToolsProvider } from "../src/providers/omp-tools-provider.js";

const context = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: { cwd: process.cwd() } as ExtensionContext,
  update: vi.fn(),
  approve: vi.fn(async () => {}),
  audits: [],
  maxResultChars: 100_000,
};

describe("CapturedToolsProvider", async () => {
  it("prepares, validates, intercepts, and executes a captured tool lazily", async () => {
    const execute = vi.fn(async (_id: string, params: { value: string }, _signal: AbortSignal | undefined, onUpdate: ((result: { content: [{ type: "text"; text: string }]; details: { progress: number } }) => void) | undefined, ctx: ExtensionContext) => {
      onUpdate?.({
        content: [{ type: "text", text: "halfway" }],
        details: { progress: 50 },
      });
      return {
        content: [{ type: "text" as const, text: `${params.value}@${ctx.cwd}` }],
        details: { original: true },
        terminate: true,
      };
    });
    const definition = ({
      name: "compat_tool",
      label: "Compat Tool",
      description: "Exercise captured execution",
      parameters: Type.Object({ value: Type.String() }),
      prepareArguments(args) {
        const input = args as { oldValue?: string };
        return { value: input.oldValue ?? "missing" };
      },
      execute,
    } as ToolDefinition & { prepareArguments(args: Record<string, unknown>): Record<string, unknown> });
    const registeredTool: RegisteredTool = { definition, extensionPath: "/extensions/pi-compat/index.ts" };
    const lifecycleEvents: string[] = [];
    const runner = {
      createContext: () => ({ cwd: "/captured-context" }),
      getActiveTools: () => [],
      emit: vi.fn(async (event: { type: string }) => {
        lifecycleEvents.push(event.type);
      }),
      emitToolCall: vi.fn(async (event: { input: Record<string, unknown> }) => {
        event.input.value = `${String(event.input.value)}!`;
        return undefined;
      }),
      emitToolResult: vi.fn(async () => ({ details: { hooked: true } })),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [registeredTool],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/omp-fabric/index.ts",
    );
    const registry = new ActionRegistry();
    registry.register(new CapturedToolsProvider(catalog));

    await expect(registry.search("compat", context)).resolves.toMatchObject([
      {
        ref: "extensions.compat_tool",
        namespace: "extension:pi-compat",
        risk: "execute",
      },
    ]);
    const result = (await registry.invoke(
      "extensions.compat_tool",
      { oldValue: "hello" },
      context,
    )) as {
      text: string;
      details: unknown;
      terminate: boolean;
      isError: boolean;
    };

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      text: "hello!@/captured-context",
      details: { hooked: true },
      terminate: true,
      isError: false,
    });
    expect(context.approve).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "extensions.compat_tool", risk: "execute" }),
      { value: "hello!" },
    );
    expect(context.update).toHaveBeenCalledWith("compat_tool: halfway");
    expect(lifecycleEvents).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
  });

  it("routes Fabric built-ins through captured extension overrides", async () => {
    const definition = ({
      name: "read",
      label: "Audited read",
      description: "Read through an extension gate",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id: string, params: { path: string }) {
        return {
          content: [{ type: "text" as const, text: `override:${params.path}` }],
          details: { override: true },
        };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [
        {
          definition,
          extensionPath: "/extensions/audited-read.ts",
        },
      ],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/omp-fabric/index.ts",
    );
    const capturedProvider = new CapturedToolsProvider(catalog);
    const registry = new ActionRegistry();
    registry.register(await OmpToolsProvider.create(process.cwd(), catalog, capturedProvider));

    await expect(registry.invoke("omp.read", { path: "README.md" }, context)).resolves.toBe(
      "override:README.md",
    );
  });

  it("discovers and routes a captured Fovea grep override", async () => {
    const definition = ({
      name: "grep",
      label: "grep (Fovea)",
      description: "Navigate the pi-fovea code graph through grep's familiar shape",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
        ignoreCase: Type.Optional(Type.Boolean()),
        literal: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: { pattern: string }) {
        return {
          content: [{ type: "text" as const, text: `fovea grep ${params.pattern}` }],
          details: { backend: "fovea" },
        };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{
        definition,
        extensionPath: "/extensions/pi-fovea/src/index.ts",
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/omp-fabric/index.ts",
    );
    const capturedProvider = new CapturedToolsProvider(catalog);
    const registry = new ActionRegistry();
    registry.register(capturedProvider);
    registry.register(await OmpToolsProvider.create(process.cwd(), catalog, capturedProvider));

    const refs = (await registry.search("fovea", context)).map((action) => action.ref);
    expect(refs).toContain("extensions.grep");
    expect(refs).toContain("omp.grep");
    await expect(registry.invoke("omp.grep", { pattern: "CreateUser" }, context)).resolves.toBe(
      "fovea grep CreateUser",
    );
  });

  it("labels an extension by its own package directory, never an omp- container above it", async () => {
    const definition = (name: string) => ({
      name,
      label: name,
      description: "Ship the current build",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: "shipped" }], details: {} };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [
        { definition: definition("deploy_release"), extensionPath: "/extensions/omp-deploy/src/index.ts" },
        { definition: definition("bundled_tool"), extensionPath: "/ext/pi-foo/dist/esm/index.js" },
        { definition: definition("nested_tool"), extensionPath: "/home/dev/omp-extensions/my-tool/index.ts" },
        { definition: definition("prototype_tool"), extensionPath: "/ext/omp-proto/constructor/index.js" },
      ],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/omp-fabric/index.ts",
    );
    const registry = new ActionRegistry();
    registry.register(new CapturedToolsProvider(catalog));

    await expect(registry.search("deploy", context)).resolves.toMatchObject([
      { ref: "extensions.deploy_release", namespace: "extension:omp-deploy" },
    ]);
    await expect(registry.search("bundled", context)).resolves.toMatchObject([
      { ref: "extensions.bundled_tool", namespace: "extension:pi-foo" },
    ]);
    await expect(registry.search("nested", context)).resolves.toMatchObject([
      { ref: "extensions.nested_tool", namespace: "extension:my-tool" },
    ]);
    await expect(registry.search("prototype", context)).resolves.toMatchObject([
      { ref: "extensions.prototype_tool", namespace: "extension:constructor" },
    ]);
  });

  it("releases scheduler barriers after an aborted non-cooperative tool", async () => {
    const hangingExecute = vi.fn(async (_id: string, _params: Record<string, never>, _signal: AbortSignal | undefined, _onUpdate: unknown, _context: unknown) => new Promise<never>(() => undefined));
    const hanging = ({
      name: "hanging_parallel",
      label: "Hanging parallel",
      description: "Never settles",
      parameters: Type.Object({}),
      execute: hangingExecute,
    });
    const sequential = ({
      name: "sequential_after_abort",
      label: "Sequential after abort",
      description: "Runs after cancellation",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        return { content: [{ type: "text" as const, text: "recovered" }], details: {} };
      },
    });
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [hanging, sequential].map((definition) => ({
        definition,
        extensionPath: `/extensions/${definition.name}.ts`,
      })),
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/omp-fabric/index.ts",
    );
    const provider = new CapturedToolsProvider(catalog);
    const controller = new AbortController();
    const hangingInvocation = provider.invoke(
      "hanging_parallel",
      {},
      { ...context, signal: controller.signal },
    );
    await vi.waitFor(() => expect(hangingExecute).toHaveBeenCalledOnce());
    controller.abort(new Error("cancel hanging tool"));
    await expect(hangingInvocation).rejects.toThrow("cancel hanging tool");

    await expect(provider.invoke(
      "sequential_after_abort",
      {},
      { ...context, signal: new AbortController().signal },
    )).resolves.toMatchObject({ text: "recovered", isError: false });
  });

  it("honors sequential execution barriers from captured definitions", async () => {
    const timeline: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const makeDefinition = (
      name: string,
      operation: () => Promise<void> | void,
      executionMode?: "sequential" | "parallel",
    ) =>
      ({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        ...(executionMode ? { executionMode } : {}),
        async execute() {
          await operation();
          return { content: [{ type: "text" as const, text: name }], details: {} };
        },
      });
    const definitions = [
      makeDefinition("parallel_first", async () => {
        timeline.push("parallel:first:start");
        await firstGate;
        timeline.push("parallel:first:end");
      }),
      makeDefinition(
        "sequential_middle",
        () => {
          timeline.push("sequential:middle");
        },
        "sequential",
      ),
      makeDefinition("parallel_last", async () => {
        timeline.push("parallel:last");
      }),
    ];
    const runner = {
      createContext: () => ({ cwd: process.cwd() }),
      getActiveTools: () => [],
      emit: vi.fn(async () => {}),
      emitToolCall: vi.fn(async () => undefined),
      emitToolResult: vi.fn(async () => undefined),
    } as unknown as ExtensionRunner;
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      definitions.map((definition) => ({
        definition,
        extensionPath: `/extensions/${definition.name}.ts`,
      })),
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/omp-fabric/index.ts",
    );
    const provider = new CapturedToolsProvider(catalog);
    const invocationContext = {
      ...context,
      update: vi.fn(),
    };

    const first = provider.invoke("parallel_first", {}, invocationContext);
    await vi.waitFor(() => expect(timeline).toEqual(["parallel:first:start"]));
    const middle = provider.invoke("sequential_middle", {}, invocationContext);
    const last = provider.invoke("parallel_last", {}, invocationContext);
    releaseFirst?.();
    await Promise.all([first, middle, last]);

    expect(timeline).toEqual([
      "parallel:first:start",
      "parallel:first:end",
      "sequential:middle",
      "parallel:last",
    ]);
  });
});
