import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG, MIN_AGENT_TIMEOUT_MS } from "../src/config.js";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import type { FabricMainAgentTarget } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import type { FabricParticipantSource } from "../src/topology/types.js";

type LaunchSurface = AgentRunResult & { tools?: string[]; imageCount?: number; cwd?: string };

const roots: string[] = [];
const agentManagers: AgentManager[] = [];
const actorManagers: ActorManager[] = [];

const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as unknown as ExtensionContext,
  update() {},
  activity() {},
};

const tempDir = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

const createManager = (): AgentManager => {
  const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(tempDir("omp-fabric-flex-runs-"), "runs"),
    fullCodeMode: false,
  });
  agentManagers.push(manager);
  return manager;
};

const setup = () => {
  const root = tempDir("omp-fabric-flex-");
  const agents = createManager();
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const identity: MeshIdentity = {
    id: "session:flex",
    name: "main",
    kind: "main",
    sessionId: "flex",
  };
  const mainAgent: FabricMainAgentTarget = {
    id: identity.id,
    local: true,
    matches: (id: string) => id === "main" || id === identity.id,
    info: () => ({
      id: identity.id,
      name: "Main" as const,
      kind: "main" as const,
      status: "idle" as const,
      runner: "omp" as const,
      transport: "host" as const,
      cwd: process.cwd(),
      sessionId: "flex",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    }),
    deliverAgent: () => ({
      queued: true as const,
      messageId: "main-message",
      routed: "main" as const,
    }),
  };
  const actors = new ActorManager(
    "flex",
    identity,
    mesh,
    { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
    agents,
    async () => {},
    { actorRoot: path.join(root, "actors"), persistent: true, mainAgent },
  );
  actorManagers.push(actors);
  const participants: FabricParticipantSource = {
    list: () => [],
    get: () => undefined,
    self: () => ({
      format: 1,
      id: identity.id,
      kind: "root",
      rootId: identity.id,
      ownerHostId: identity.id,
      ownerIdentityId: identity.id,
      name: "main",
      status: "idle",
      runner: "omp",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      cwd: process.cwd(),
      sessionId: "flex",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      controlProtocol: "v1",
      local: true,
      stale: false,
    }),
    peers: () => [],
    async refresh() {},
    scheduleRefresh() {},
  };
  let provider: AgentsProvider;
  const lifecycle = new LifecycleBroker(
    mesh,
    identity,
    participants,
    { enabled: false, pollMs: 1_000, maxReadEvents: 100 },
    async (subscription, event) => provider.deliverLifecycle(subscription, event),
  );
  provider = new AgentsProvider(
    agents,
    actors,
    new GlobalActorRegistry(root, 64 * 1024),
    mainAgent,
    participants,
    undefined,
    lifecycle,
  );
  return { agents, actors, provider };
};

afterEach(async () => {
  await Promise.all(actorManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(agentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("per-call agent timeouts", () => {
  it("carries a timeout below the configured default into the run request", async () => {
    const { agents, provider } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    expect(DEFAULT_FABRIC_CONFIG.agents.timeoutMs).toBeGreaterThan(240_000);
    await provider.invoke("spawn", { task: "probe", transport: "process", timeoutMs: 240_000 }, context);
    expect(spawn.mock.calls[0]?.[0].timeoutMs).toBe(240_000);
  });

  it("carries a timeout above the configured default into the run request", async () => {
    const { agents, provider } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    await provider.invoke("spawn", { task: "probe", transport: "process", timeoutMs: 7_200_000 }, context);
    expect(spawn.mock.calls[0]?.[0].timeoutMs).toBe(7_200_000);
  });

  it("clamps a timeout below the supported floor", async () => {
    const { agents, provider } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    await provider.invoke("spawn", { task: "probe", transport: "process", timeoutMs: 500 }, context);
    expect(spawn.mock.calls[0]?.[0].timeoutMs).toBe(MIN_AGENT_TIMEOUT_MS);
  });

  it("ends a hung child at the shorter per-call deadline", async () => {
    const agents = createManager();

    const result = await agents.run({ task: "HANG", transport: "process", timeoutMs: 2_000 });
    expect(result.status).toBe("timed_out");
  }, 30_000);
});

describe("agent run images", () => {
  it("forwards image blocks into the run request", async () => {
    const { agents, provider } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    await provider.invoke("spawn", { task: "probe", transport: "process", images: [image] }, context);
    expect(spawn.mock.calls[0]?.[0].images).toEqual([image]);
  });

  it("drops entries that are not image blocks", async () => {
    const { agents, provider } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    await provider.invoke(
      "spawn",
      { task: "probe", transport: "process", images: ["not-an-image", { type: "image" }] },
      context,
    );
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("images");
  });

  it("delivers forwarded images to the child worker", async () => {
    const agents = createManager();

    const result = (await agents.run({
      task: "probe",
      transport: "process",
      images: [image],
    })) as LaunchSurface;
    expect(result.status).toBe("completed");
    expect(result.imageCount).toBe(1);
  }, 30_000);
});

describe("additive child tool selection", () => {
  it("forwards addTools into the run request", async () => {
    const { agents, provider } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    await provider.invoke(
      "spawn",
      { task: "probe", transport: "process", addTools: ["web_search"] },
      context,
    );
    expect(spawn.mock.calls[0]?.[0].addTools).toEqual(["web_search"]);
  });

  it("extends the configured defaults without restating them", async () => {
    const agents = createManager();

    const result = (await agents.run({
      task: "probe",
      transport: "process",
      addTools: ["web_search"],
    })) as LaunchSurface;
    expect(result.tools).toEqual([...DEFAULT_FABRIC_CONFIG.agents.defaultTools, "web_search"]);
  }, 30_000);

  it("appends to an explicit tool list without duplicates", async () => {
    const agents = createManager();

    const result = (await agents.run({
      task: "probe",
      transport: "process",
      tools: ["read"],
      addTools: ["web_search", "read"],
    })) as LaunchSurface;
    expect(result.tools).toEqual(["read", "web_search"]);
  }, 30_000);
});

describe("persistent actor cwd", () => {
  const actorRequest = {
    name: "cwd-actor",
    instructions: "Work only inside the pinned directory.",
    extensions: false,
  };

  it("rejects an unusable directory exactly like the run path", async () => {
    const { provider } = setup();
    const missing = path.join(os.tmpdir(), "omp-fabric-flex-absent-directory");

    const runError = await provider
      .invoke("spawn", { task: "probe", transport: "process", cwd: missing }, context)
      .then(() => undefined, (error: Error) => error);
    const actorError = await provider
      .invoke("create", { ...actorRequest, cwd: missing }, context)
      .then(() => undefined, (error: Error) => error);

    expect(runError?.message).toContain(`Invalid Fabric agent cwd ${JSON.stringify(missing)}`);
    expect(actorError?.message).toBe(runError?.message);
  });

  it("refuses a cwd the actor would run recursively", async () => {
    const { provider } = setup();
    const directory = tempDir("omp-fabric-flex-actor-cwd-");

    await expect(
      provider.invoke("create", { ...actorRequest, extensions: true, cwd: directory }, context),
    ).rejects.toThrow("supported only for non-recursive agents");
  });

  it("threads a validated cwd into every actor activation", async () => {
    const { agents, actors, provider } = setup();
    const directory = tempDir("omp-fabric-flex-actor-cwd-");
    const resolved = fs.realpathSync(directory);

    const created = (await provider.invoke(
      "create",
      { ...actorRequest, cwd: path.relative(process.cwd(), directory) },
      context,
    )) as { id: string };
    expect(actors.definition(created.id).cwd).toBe(resolved);

    const run = vi.spyOn(agents, "run");
    await actors.ask(created.id, "probe");
    expect(run.mock.calls[0]?.[0].cwd).toBe(resolved);
  }, 30_000);
});
