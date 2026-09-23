import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ompFabric from "../src/index.js";
import { hostToolForCore, OMP_CORE_TOOL_NAMES } from "../src/core/omp-tools.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import type { OmpToolsProvider } from "../src/providers/omp-tools-provider.js";

const created = vi.hoisted(() => ({ provider: undefined as OmpToolsProvider | undefined }));

vi.mock("../src/providers/omp-tools-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/omp-tools-provider.js")>();
  return {
    ...actual,
    OmpToolsProvider: class extends actual.OmpToolsProvider {
      static override async create(
        ...args: Parameters<typeof actual.OmpToolsProvider.create>
      ): Promise<OmpToolsProvider> {
        created.provider = await actual.OmpToolsProvider.create(...args);
        return created.provider;
      }
    },
  };
});

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

const roots: string[] = [];

const fullCodeRoot = (): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-host-authority-"));
  roots.push(cwd);
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "fabric.json"),
    JSON.stringify({
      fullCodeMode: true,
      prewalk: { alwaysRearm: true },
      mesh: { enabled: false },
      components: [],
    }),
  );
  vi.stubEnv("OMP_FABRIC_AGENT_DIR", agentDir);
  vi.stubEnv("OMP_FABRIC_PROJECT_ROOT", cwd);
  vi.stubEnv("OMP_FABRIC_TOOL_ALLOWLIST", undefined);
  return cwd;
};

const startSession = async (cwd: string, hostTools: string[]): Promise<{ activeTools: string[] }> => {
  const handlers = new Map<string, ExtensionHandler[]>();
  const toolInfos: unknown[] = [];
  let activeTools = [...hostTools];

  const omp = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    getActiveTools: vi.fn(() => activeTools),
    getAllTools: vi.fn(() => toolInfos),
    on: vi.fn((event: string, handler: ExtensionHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn((tool: { name: string }) => {
      toolInfos.push({ name: tool.name, sourceInfo: { path: path.resolve(process.cwd(), "src/index.ts") } });
      if (!activeTools.includes(tool.name)) activeTools = [...activeTools, tool.name];
    }),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = [...names];
    }),
  } as unknown as ExtensionAPI;

  await ompFabric(omp);

  const context = {
    mode: "code",
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "host-authority-session",
      getLeafId: () => null,
      getRecordedCwd: () => cwd,
      getArtifactsDir: () => path.join(cwd, "artifacts"),
      getSessionFile: () => null,
    },
  } as unknown as ExtensionContext;

  for (const handler of handlers.get("session_start") ?? []) await handler(undefined, context);
  return { get activeTools() { return activeTools; } };
};

beforeEach(() => { created.provider = undefined; });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("omp provider host tool authority", () => {
  it("keeps core tools callable after full code mode hides them from the model", async () => {
    const cwd = fullCodeRoot();
    const session = await startSession(cwd, [...OMP_CORE_TOOL_NAMES.map(hostToolForCore), "task"]);

    expect(session.activeTools).not.toContain("read");
    const provider: OmpToolsProvider | undefined = created.provider;
    expect(provider).toBeDefined();
    const invocation = { cwd, signal: new AbortController().signal } as FabricInvocationContext;
    expect((await provider!.list({}, invocation)).map((entry) => entry.name))
      .toEqual([...OMP_CORE_TOOL_NAMES]);
    expect(() => provider!.prepareArguments("read", { path: "x" })).not.toThrow();
  }, 60000);

  it("denies a core tool OMP itself has turned off", async () => {
    const cwd = fullCodeRoot();
    await startSession(cwd, ["read", "grep", "task"]);

    const provider: OmpToolsProvider | undefined = created.provider;
    expect(provider).toBeDefined();
    const invocation = { cwd, signal: new AbortController().signal } as FabricInvocationContext;
    expect((await provider!.list({}, invocation)).map((entry) => entry.name)).toEqual(["read", "grep"]);
    await expect(provider!.invoke("bash", { command: "must-not-execute" }, invocation))
      .rejects.toThrow(/OMP's active tool selection/);
  }, 60000);
});
