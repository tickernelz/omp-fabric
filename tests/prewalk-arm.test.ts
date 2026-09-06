import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { FabricPrewalkMode } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import { armFabricPrewalkSession, autoArmFabricPrewalk } from "../src/prewalk/arm.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import { PREWALK_ARMED_MESSAGE_TYPE, prewalkArmedPrompt } from "../src/prewalk/handoff.js";
import type { FabricThinking } from "../src/thinking.js";

const CWD = "/tmp/fabric-prewalk-arm-test";

interface Harness {
  state: FabricState;
  context: ExtensionContext;
  omp: ExtensionAPI;
  prewalk: PrewalkController;
  captureBaseline: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
}

const makeHarness = (
  input: {
    alwaysRearm?: boolean;
    mode?: FabricPrewalkMode;
    model?: string;
    thinking?: FabricThinking;
    detectShellWrites?: boolean;
    enabled?: boolean;
    fullCodeMode?: boolean;
    schemaMode?: string;
    agentsEnabled?: boolean;
    branch?: unknown[];
  } = {},
): Harness => {
  const prewalk = new PrewalkController();
  const captureBaseline = vi.fn(async () => {});
  const sendMessage = vi.fn();
  const setStatus = vi.fn();
  const branch = input.branch ?? [];
  const state = {
    config: {
      fullCodeMode: input.fullCodeMode ?? true,
      schema: { mode: input.schemaMode ?? "assist" },
      agents: { enabled: input.agentsEnabled ?? true },
      prewalk: {
        ...(input.enabled === false ? { enabled: false } : {}),
        mode: input.mode ?? "in-place",
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        alwaysRearm: input.alwaysRearm ?? true,
        detectShellWrites: input.detectShellWrites ?? true,
      },
    },
    prewalk,
    prewalkDrift: { captureBaseline },
  } as unknown as FabricState;
  const context = {
    cwd: CWD,
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
    ui: { setStatus, notify: vi.fn() },
  } as unknown as ExtensionContext;
  const omp = { sendMessage } as unknown as ExtensionAPI;
  return { state, context, omp, prewalk, captureBaseline, sendMessage, setStatus };
};

describe("armFabricPrewalkSession", () => {
  it("arms from the live config and mirrors arm-time side effects", async () => {
    const h = makeHarness({ model: "anthropic/executor", thinking: "high" });

    await armFabricPrewalkSession(h.state, h.context, h.omp, {
      model: "anthropic/executor",
      task: "  draft the guard  ",
    });

    expect(h.prewalk.status()).toMatchObject({
      state: "armed",
      mode: "in-place",
      model: "anthropic/executor",
      sessionId: "session-1",
      alwaysRearm: true,
      task: "draft the guard",
      thinking: "high",
    });
    expect(h.captureBaseline).toHaveBeenCalledWith("session-1", CWD);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: PREWALK_ARMED_MESSAGE_TYPE,
      display: false,
      content: prewalkArmedPrompt("in-place", "anthropic/executor"),
    });
    expect(h.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "nextTurn" });
    expect(h.setStatus).toHaveBeenCalledWith(
      "fabric-prewalk",
      "armed (in-place) → anthropic/executor",
    );
  });

  it("queues the armed advisory only once per identical prompt", async () => {
    const h = makeHarness({
      branch: [
        {
          type: "custom_message",
          customType: PREWALK_ARMED_MESSAGE_TYPE,
          content: prewalkArmedPrompt("in-place", "anthropic/executor"),
        },
      ],
    });

    await armFabricPrewalkSession(h.state, h.context, h.omp, { model: "anthropic/executor" });

    expect(h.prewalk.status().state).toBe("armed");
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("skips the drift baseline when shell-write detection is off", async () => {
    const h = makeHarness({ detectShellWrites: false });

    await armFabricPrewalkSession(h.state, h.context, h.omp, { model: "anthropic/executor" });

    expect(h.captureBaseline).not.toHaveBeenCalled();
    expect(h.prewalk.status().state).toBe("armed");
  });
});

describe("autoArmFabricPrewalk", () => {
  it("stays silent when the prewalk master switch is off", async () => {
    const h = makeHarness({ model: "anthropic/executor", enabled: false });

    const skip = await autoArmFabricPrewalk(h.state, h.context, h.omp);

    expect(skip).toBeUndefined();
    expect(h.prewalk.status().state).toBe("idle");
  });

  it("arms new sessions from prewalk.model", async () => {
    const h = makeHarness({ model: "anthropic/executor" });

    const skip = await autoArmFabricPrewalk(h.state, h.context, h.omp);

    expect(skip).toBeUndefined();
    expect(h.prewalk.status()).toMatchObject({
      state: "armed",
      mode: "in-place",
      model: "anthropic/executor",
      sessionId: "session-1",
      alwaysRearm: true,
    });
    expect(h.captureBaseline).toHaveBeenCalledWith("session-1", CWD);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("stays silent when always re-arm is off", async () => {
    const h = makeHarness({ alwaysRearm: false, model: "anthropic/executor" });

    const skip = await autoArmFabricPrewalk(h.state, h.context, h.omp);

    expect(skip).toBeUndefined();
    expect(h.prewalk.status().state).toBe("idle");
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("never clobbers an existing arm", async () => {
    const h = makeHarness({ model: "anthropic/executor" });
    h.prewalk.arm({ model: "openai/manual", sessionId: "session-1", alwaysRearm: true });

    const skip = await autoArmFabricPrewalk(h.state, h.context, h.omp);

    expect(skip).toBeUndefined();
    expect(h.prewalk.status().state).toBe("armed");
    expect(h.prewalk.status()).toMatchObject({ model: "openai/manual" });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "full code mode disabled",
      harness: { model: "anthropic/executor", fullCodeMode: false },
      reason: "full code mode",
    },
    {
      name: "Schema enforce mode on",
      harness: { model: "anthropic/executor", schemaMode: "enforce" },
      reason: "Schema enforce mode",
    },
    {
      name: "trajectory without agents",
      harness: { model: "anthropic/executor", mode: "trajectory" as const, agentsEnabled: false },
      reason: "agents.enabled",
    },
    {
      name: "prewalk.model unset",
      harness: {},
      reason: "prewalk.model",
    },
    {
      name: "prewalk.model not provider/model",
      harness: { model: "plain-model" },
      reason: "prewalk.model",
    },
  ])("returns a skip reason when $name", async ({ harness, reason }) => {
    const h = makeHarness(harness);

    const skip = await autoArmFabricPrewalk(h.state, h.context, h.omp);

    expect(skip).toContain(reason);
    expect(h.prewalk.status().state).toBe("idle");
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.captureBaseline).not.toHaveBeenCalled();
  });
});
