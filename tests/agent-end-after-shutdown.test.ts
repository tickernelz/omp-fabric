import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompFabric from "../src/index.js";

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

const roots: string[] = [];

const fabricRoot = (): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-agent-end-"));
  roots.push(cwd);
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "fabric.json"),
    JSON.stringify({ fullCodeMode: false, prewalk: { alwaysRearm: false }, mesh: { enabled: false }, components: [] }),
  );
  vi.stubEnv("OMP_FABRIC_AGENT_DIR", agentDir);
  vi.stubEnv("OMP_FABRIC_PROJECT_ROOT", cwd);
  return cwd;
};

const session = (cwd: string): ExtensionContext => {
  const context = {
    mode: "print",
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    model: undefined,
    getContextUsage: () => undefined,
    compact: vi.fn(async () => {}),
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "agent-end-session",
      getLeafId: () => null,
      getRecordedCwd: () => cwd,
      getArtifactsDir: () => path.join(cwd, "artifacts"),
      getSessionFile: () => null,
    },
  } as unknown as ExtensionContext;

  return context;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent_end after session teardown", () => {
  it("does not throw when the host emits agent_end after session_shutdown", async () => {
    const cwd = fabricRoot();
    const context = session(cwd);
    const handlers = new Map<string, ExtensionHandler[]>();
    await ompFabric({
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getActiveTools: () => ["read", "bash"],
      getAllTools: () => [],
      on: (event: string, handler: ExtensionHandler) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI);

    for (const handler of handlers.get("session_start") ?? []) await handler(undefined, context);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler(undefined, context);

    const failures: unknown[] = [];
    for (const handler of handlers.get("agent_end") ?? []) {
      try {
        await handler({ willContinue: false }, context);
      } catch (error) {
        failures.push(error);
      }
    }
    expect(failures.map((error) => String(error))).toEqual([]);
  }, 60_000);
});
