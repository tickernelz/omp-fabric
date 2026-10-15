import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompFabric from "../src/index.js";

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

const captured = vi.hoisted(() => ({ contexts: [] as unknown[] }));

vi.mock("../src/providers/memory-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/memory-provider.js")>();
  return {
    ...actual,
    MemoryProvider: class extends actual.MemoryProvider {
      constructor(context: unknown) {
        captured.contexts.push(context);
        super(context as never);
      }
    },
  };
});

const roots: string[] = [];

const lcmRoot = (): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-lcm-context-"));
  roots.push(cwd);
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "fabric.json"),
    JSON.stringify({
      prewalk: { alwaysRearm: true },
      mesh: { enabled: false },
      components: [],
      memory: { enabled: true },
      compaction: { engine: "lcm" },
      update: { check: false },
    }),
  );
  vi.stubEnv("OMP_FABRIC_AGENT_DIR", agentDir);
  vi.stubEnv("OMP_FABRIC_PROJECT_ROOT", cwd);
  return cwd;
};

afterEach(() => {
  captured.contexts.length = 0;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("fabric memory provider LCM context", () => {
  it("installs the memory provider with the LCM context already available", async () => {
    const cwd = lcmRoot();
    const handlers = new Map<string, ExtensionHandler[]>();
    const omp = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getActiveTools: vi.fn(() => ["fabric_exec"]),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: ExtensionHandler) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
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
        getSessionId: () => "lcm-context-session",
        getLeafId: () => null,
        getRecordedCwd: () => cwd,
        getArtifactsDir: () => path.join(cwd, "artifacts"),
        getSessionFile: () => null,
      },
    } as unknown as ExtensionContext;

    for (const handler of handlers.get("session_start") ?? []) await handler(undefined, context);

    expect(captured.contexts.length).toBeGreaterThan(0);
    const installed = captured.contexts[0] as { lcm?: unknown; sessionId?: string };
    expect(installed.lcm).toBeDefined();
    expect(installed.sessionId).toBe("lcm-context-session");
  }, 60000);
});
