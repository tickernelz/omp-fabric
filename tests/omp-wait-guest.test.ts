import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricInvocationContext } from "../src/protocol.js";
import { FABRIC_OWNED_HOST_TOOLS, OMP_GUEST_TOOL_NAMES } from "../src/core/omp-tools.js";
import {
  OmpToolsProvider,
  TRUNCATION_MARKER,
  setOmpSessionIdentity,
} from "../src/providers/omp-tools-provider.js";

const SESSION_ID = "omp-wait-session";
const OWNER_ID = "omp-wait-owner";

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

const registerSession = (manager: AsyncJobManager): void => {
  AgentRegistry.global().register({
    id: OWNER_ID,
    displayName: OWNER_ID,
    kind: "sub",
    session: {
      sessionManager: { getSessionId: () => SESSION_ID },
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

afterEach(async () => {
  setOmpSessionIdentity(undefined);
  AgentRegistry.global().unregister(OWNER_ID);
  for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
});

describe("omp.wait", () => {
  it("collects the output of a job the same program started", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    const started = (await provider.invoke(
      "bash",
      { command: "printf waited-output", async: true },
      context(),
    )) as { details: { async?: { jobId?: string; state?: string } } };
    expect(started.details.async?.state).toBe("running");

    const waited = (await provider.invoke("wait", {}, context())) as { ok: boolean; output: string };

    expect(waited.ok).toBe(true);
    expect(waited.output).toContain("waited-output");
  });

  it("is advertised to a program but never owned by fabric", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    const listed = (await provider.list({}, context())).map((descriptor) => descriptor.name);
    expect(listed).toContain("wait");
    expect(OMP_GUEST_TOOL_NAMES).toContain("wait");
    expect(FABRIC_OWNED_HOST_TOOLS.has("wait")).toBe(false);

    const descriptor = await provider.describe("wait", context());
    expect(descriptor?.description).toBeTruthy();
  });

  it("bounds a large job result and keeps the truncation marker inside the cap", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    const cap = 800;
    const payload = "x".repeat(cap * 12);
    await provider.invoke("bash", { command: `printf '%s' ${JSON.stringify(payload)}`, async: true }, context());
    const waited = (await provider.invoke(
      "wait",
      {},
      { ...context(), maxResultChars: cap } as unknown as FabricInvocationContext,
    )) as { ok: boolean; output: string };

    expect(waited.ok).toBe(true);
    expect(waited.output.length).toBeLessThanOrEqual(cap);
    expect(waited.output).toContain(TRUNCATION_MARKER);
    expect(waited.output).toContain("wait");
  });

  it("binds its job manager when the provider is created, not when it is called", async () => {
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    registerSession(liveManager());

    const bash = await provider.describe("bash", context());
    expect((bash?.inputSchema.properties as Record<string, unknown> | undefined)?.async).toBeUndefined();
    await expect(provider.invoke("wait", {}, context())).rejects.toThrow(/Nothing to wait for/i);
  });

  it("is denied when the host's active tool selection omits it", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(
      process.cwd(),
      undefined,
      undefined,
      () => new Set(["read", "bash", "grep"]),
    );

    const listed = (await provider.list({}, context())).map((descriptor) => descriptor.name);
    expect(listed).not.toContain("wait");
    await expect(provider.invoke("wait", {}, context())).rejects.toThrow(
      /not permitted by OMP's active tool selection/,
    );
  });

  it("reports nothing to wait for instead of hanging when no job is running", async () => {
    registerSession(liveManager());
    setOmpSessionIdentity({ getSessionId: () => SESSION_ID });
    const provider = await OmpToolsProvider.create(process.cwd());

    await expect(provider.invoke("wait", {}, context())).rejects.toThrow(/Nothing to wait for/i);
  });
});
