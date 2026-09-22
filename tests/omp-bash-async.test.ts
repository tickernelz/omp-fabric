import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricInvocationContext } from "../src/protocol.js";
import { ompJobScope, shellBackgroundSettings } from "../src/providers/omp-session-scope.js";
import { OmpToolsProvider, setOmpSessionIdentity } from "../src/providers/omp-tools-provider.js";

const SESSION_ID = "omp-bash-async-session";
const OWNER_ID = "omp-bash-async-owner";

const context = (): FabricInvocationContext =>
  ({
    cwd: process.cwd(),
    signal: undefined,
    parentToolCallId: "parent",
    nestedToolCallId: "nested",
    extensionContext: {} as never,
    update() {},
  }) as unknown as FabricInvocationContext;

const managers: AsyncJobManager[] = [];

const registerSession = (manager?: AsyncJobManager, sessionId = SESSION_ID): void => {
  AgentRegistry.global().register({
    id: OWNER_ID,
    displayName: OWNER_ID,
    kind: "sub",
    session: {
      sessionManager: { getSessionId: () => sessionId },
      getAgentId: () => OWNER_ID,
      asyncJobManager: manager,
    } as never,
  });
};

const liveManager = (): AsyncJobManager => {
  const manager = new AsyncJobManager({ maxRunningJobs: 4 });
  managers.push(manager);
  return manager;
};

const bashDescriptor = async (
  provider: OmpToolsProvider,
): Promise<{ description: string; properties: Record<string, unknown> }> => {
  const descriptor = await provider.describe("bash", context());
  if (!descriptor) throw new Error("bash descriptor missing");
  return {
    description: descriptor.description,
    properties: (descriptor.inputSchema.properties ?? {}) as Record<string, unknown>,
  };
};

afterEach(async () => {
  setOmpSessionIdentity(undefined);
  AgentRegistry.global().unregister(OWNER_ID);
  for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
});

describe("omp.bash background jobs", () => {
  it("runs an async command as a managed job and delivers its result to the owner", async () => {
    const manager = liveManager();
    registerSession(manager);
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });

    let resolveDelivered: (value: { jobId: string; text: string }) => void = () => {};
    const delivered = new Promise<{ jobId: string; text: string }>((resolve) => {
      resolveDelivered = resolve;
    });
    manager.registerDeliverySink(OWNER_ID, (jobId, text) => resolveDelivered({ jobId, text }));

    const provider = await OmpToolsProvider.create(process.cwd());
    expect((await bashDescriptor(provider)).properties.async).toBeDefined();

    const started = (await provider.invoke(
      "bash",
      { command: "printf background-ran", async: true },
      context(),
    )) as { output: string; details: { async?: { jobId?: string; state?: string } } };

    expect(started.details.async?.state).toBe("running");
    expect(started.output).toContain("Backgrounded as job");

    const result = await delivered;
    expect(result.jobId).toBe(started.details.async?.jobId);
    expect(result.text).toContain("background-ran");
    expect(manager.getJob(result.jobId)?.ownerId).toBe(OWNER_ID);
  });

  it("keeps a foreground command in the foreground whatever its timeout", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });

    const provider = await OmpToolsProvider.create(process.cwd());
    const result = (await provider.invoke(
      "bash",
      { command: "printf foreground-ran", timeout: 1 },
      context(),
    )) as { output: string; details: { async?: unknown } };

    expect(result.output.trim()).toBe("foreground-ran");
    expect(result.details.async).toBeUndefined();
  });

  it("follows the owner across a session id change", async () => {
    const manager = liveManager();
    registerSession(manager, "first-session");
    let sessionId = "first-session";
    setOmpSessionIdentity({ getSessionId: () => sessionId });

    const provider = await OmpToolsProvider.create(process.cwd());
    registerSession(manager, "second-session");
    sessionId = "second-session";

    const started = (await provider.invoke(
      "bash",
      { command: "printf renamed", async: true },
      context(),
    )) as { details: { async?: { jobId?: string } } };

    expect(manager.getJob(String(started.details.async?.jobId))?.ownerId).toBe(OWNER_ID);
  });

  it("drops async from the surface when no agent owns this session", async () => {
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    const descriptor = await bashDescriptor(provider);
    expect(descriptor.properties.async).toBeUndefined();
    expect(descriptor.description).not.toContain("auto-background");

    await expect(
      provider.invoke("bash", { command: "printf nope", async: true }, context()),
    ).rejects.toThrow("Async bash execution is disabled");
  });

  it("drops async from the surface when the owning session has no job manager", async () => {
    registerSession(undefined);
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    expect((await bashDescriptor(provider)).properties.async).toBeUndefined();
  });

  it("keeps the shell parameter descriptions in both schema branches", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const armed = await bashDescriptor(await OmpToolsProvider.create(process.cwd()));
    expect(armed.properties.async).toBeDefined();
    expect(armed.description).not.toContain("auto-background");

    AgentRegistry.global().unregister(OWNER_ID);
    const plain = await bashDescriptor(await OmpToolsProvider.create(process.cwd()));

    for (const field of ["command", "cwd", "pty", "timeout"]) {
      expect((armed.properties[field] as { description?: string }).description).toBeTruthy();
      expect((plain.properties[field] as { description?: string }).description).toBeTruthy();
    }
  });
});

describe("shellBackgroundSettings", () => {
  const scope = { manager: {} as AsyncJobManager, agentId: () => OWNER_ID };

  it("mirrors the host async switch and never arms auto-background", () => {
    expect(shellBackgroundSettings(scope, () => true)).toEqual({
      "async.enabled": true,
      "bash.autoBackground.enabled": false,
    });
    expect(shellBackgroundSettings(scope, () => false)).toEqual({
      "async.enabled": false,
      "bash.autoBackground.enabled": false,
    });
  });

  it("disables async without a job scope", () => {
    expect(shellBackgroundSettings(undefined, () => true)).toEqual({
      "async.enabled": false,
      "bash.autoBackground.enabled": false,
    });
  });
});

describe("ompJobScope", () => {
  it("resolves no scope for a session no live agent owns", () => {
    expect(ompJobScope(() => "unknown-session")).toBeUndefined();
    expect(ompJobScope(() => null)).toBeUndefined();
  });
});
