import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompFabric from "../src/index.js";

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

const roots: string[] = [];

const coldRoot = (): string => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-cold-start-"));
  roots.push(cwd);
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("OMP_FABRIC_AGENT_DIR", agentDir);
  vi.stubEnv("OMP_FABRIC_PROJECT_ROOT", cwd);
  return cwd;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("fabric compaction before the LCM runtime is up", () => {
  it("leaves compaction to the host instead of cancelling it", async () => {
    const cwd = coldRoot();
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

    const compactHandlers = handlers.get("session_before_compact") ?? [];
    expect(compactHandlers.length).toBeGreaterThan(0);

    const context = {
      cwd,
      isProjectTrusted: () => true,
      hasUI: false,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "cold-start-session",
        getLeafId: () => null,
        getRecordedCwd: () => cwd,
        getArtifactsDir: () => path.join(cwd, "artifacts"),
        getSessionFile: () => null,
      },
    } as unknown as ExtensionContext;

    const event = {
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 10 },
      branchEntries: [],
    };
    for (const handler of compactHandlers) {
      expect(await handler(event, context)).toBeUndefined();
    }
  }, 30000);
});
