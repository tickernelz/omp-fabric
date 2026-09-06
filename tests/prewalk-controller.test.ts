import { describe, expect, it } from "vitest";
import type { FabricCallAudit } from "../src/core/action-registry.js";
import { PrewalkController } from "../src/prewalk/controller.js";

const audit = (
  ref: string,
  success: boolean,
  sequence = 1,
): FabricCallAudit => ({
  ref,
  nestedToolCallId: `call-${sequence}`,
  startedAt: sequence,
  endedAt: sequence + 1,
  success,
});

describe("PrewalkController", () => {
  it("arms a one-shot executor and captures the next task when omitted", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.isArmed("session-1")).toBe(true);
    controller.observeTask("session-1", "  Implement the guard  ");
    controller.observeTask("session-1", "Do not replace the first task");

    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
  });

  it("keeps the arm across read-only settles, dropping only the settled task", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.settleTask("session-1")).toBe(true);
    expect(controller.status().state).toBe("armed");
    controller.observeTask("session-1", "Inspect without changing anything");
    expect(controller.settleTask("session-2")).toBe(false);
    expect(controller.settleTask("session-1")).toBe(true);
    expect(controller.status()).toMatchObject({ state: "armed", sessionId: "session-1" });
    expect(controller.status()).not.toHaveProperty("task");
  });

  // Regression: a plan-first turn (reads only) must not burn the arm — the
  // next matching mutation boundary still claims the handoff.
  it("claims a mutation that lands after earlier read-only settles", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    controller.observeTask("session-1", "Survey the module");
    expect(controller.settleTask("session-1")).toBe(true);
    controller.observeTask("session-1", "Implement it now");
    expect(
      controller.claim(
        [audit("omp.read", true), audit("omp.write", true, 2)],
        "session-1",
      ),
    ).toMatchObject({
      arm: { model: "anthropic/executor", task: "Implement it now" },
      mutation: { ref: "omp.write" },
    });
  });

  it("re-arms without leaking the previous task when always re-arm is enabled", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Inspect without changing anything",
      alwaysRearm: true,
    });

    expect(controller.settleTask("session-1")).toBe(true);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");

    controller.observeTask("session-1", "Implement the next task");
    expect(controller.status()).toMatchObject({ task: "Implement the next task" });
  });

  it("claims only the first successful recognized mutation", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
    });

    expect(
      controller.claim(
        [audit("omp.read", true), audit("omp.edit", false, 2)],
        "session-1",
      ),
    ).toBeUndefined();
    const claim = controller.claim(
      [audit("omp.read", true), audit("omp.write", true, 2)],
      "session-1",
    );

    expect(claim).toMatchObject({
      arm: { model: "anthropic/executor", task: "Implement" },
      mutation: { ref: "omp.write", success: true },
    });
    expect(controller.status()).toMatchObject({ state: "handing_off" });
    expect(controller.claim([audit("schema.commit", true)], "session-1")).toBeUndefined();
  });

  it("does not cross session boundaries", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.claim([audit("omp.edit", true)], "session-2")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

  it("disarms when the program already performed an explicit handoff", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(
      controller.claim(
        [audit("omp.edit", true), audit("agents.handoff", true, 2)],
        "session-1",
      ),
    ).toBeUndefined();
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("orders claims with a session-monotonic seq that survives re-arms and cancels", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      alwaysRearm: true,
    });

    expect(controller.claim([audit("omp.edit", true)], "session-1")?.seq).toBe(1);
    expect(controller.completeTask()).toMatchObject({ state: "armed" });

    expect(controller.claimFsDrift("session-1", ["a.ts"])?.seq).toBe(2);
    controller.cancel();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    expect(controller.claim([audit("omp.write", true)], "session-1")?.seq).toBe(3);
    // Other sessions start their own sequence.
    controller.arm({ model: "anthropic/executor", sessionId: "session-2" });
    expect(controller.claimFsDrift("session-2", ["b.ts"])?.seq).toBe(1);
  });

  it("claims filesystem drift with a synthesized fs.drift mutation audit", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1", task: "Implement" });

    const claim = controller.claimFsDrift("session-1", ["src/a.ts", "src/b.ts"]);

    expect(claim).toMatchObject({
      arm: { model: "anthropic/executor", task: "Implement", mode: "in-place" },
      mutation: {
        ref: "fs.drift",
        success: true,
        args: { files: ["src/a.ts", "src/b.ts"] },
      },
    });
    expect(controller.status()).toMatchObject({ state: "handing_off" });
    expect(controller.claimFsDrift("session-1", ["src/c.ts"])).toBeUndefined();
  });

  it("refuses filesystem claims when idle, busy, or across sessions", () => {
    const controller = new PrewalkController();
    expect(controller.claimFsDrift("session-1", ["a.ts"])).toBeUndefined();

    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });
    expect(controller.claimFsDrift("session-2", ["a.ts"])).toBeUndefined();

    controller.claimFsDrift("session-1", []);
    expect(controller.status()).toMatchObject({ state: "handing_off" });
    expect(controller.claimFsDrift("session-1", ["a.ts"])).toBeUndefined();
  });

  it("falls back to armed after a failed filesystem handoff", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    controller.claimFsDrift("session-1", ["a.ts"]);
    expect(controller.failHandoff()).toMatchObject({ state: "armed" });
  });
});
