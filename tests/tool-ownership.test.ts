import { describe, expect, it, vi } from "vitest";
import {
  createToolOwnershipReassertion,
  FabricToolOwnership,
} from "../src/core/tool-ownership.js";

const hostWith = (initial: string[]) => {
  let active = [...initial];
  const setActiveTools = vi.fn((names: string[]) => {
    active = [...names];
  });
  return {
    host: {
      getActiveTools: () => [...active],
      setActiveTools,
    },
    active: () => active,
    setActiveTools,
  };
};

describe("FabricToolOwnership", () => {
  it("gives Fabric exclusive ownership of active OMP core tools", () => {
    const state = hostWith([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "custom_tool",
      "fabric_exec",
    ]);
    const ownership = new FabricToolOwnership(state.host);

    expect(ownership.apply(true)).toBe(true);
    expect(state.active()).toEqual(["custom_tool", "fabric_exec"]);
    expect(state.setActiveTools).toHaveBeenCalledOnce();

    expect(ownership.apply(true)).toBe(false);
    expect(state.setActiveTools).toHaveBeenCalledOnce();
  });

  it("restores only the native core tools that were active before full mode", () => {
    const state = hostWith(["read", "find", "custom_tool", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true);
    expect(state.active()).toEqual(["custom_tool", "fabric_exec"]);
    expect(ownership.apply(false)).toBe(true);
    expect(state.active()).toEqual(["read", "find", "custom_tool", "fabric_exec"]);
    expect(state.active()).not.toContain("bash");
  });

  it("removes core tools re-enabled while full mode remains active", () => {
    const state = hostWith(["read", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true);
    state.host.setActiveTools(["fabric_exec", "read", "ls"]);
    expect(ownership.apply(true)).toBe(true);
    expect(state.active()).toEqual(["fabric_exec"]);

    ownership.release();
    expect(state.active()).toEqual(["read", "fabric_exec"]);
  });

  it("does not alter native tools in orchestration-only mode", () => {
    const state = hostWith(["read", "bash", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    expect(ownership.apply(false)).toBe(false);
    expect(state.active()).toEqual(["read", "bash", "fabric_exec"]);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it("hides captured extension tools from the active set in full code mode", () => {
    // Captured tools remain registered (visible to omp.getAllTools() consumers
    // such as permission systems); only the model-facing active set is pruned.
    const state = hostWith(["read", "ask_user_question", "deploy_release", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    expect(
      ownership.apply(true, new Set(["ask_user_question", "deploy_release"])),
    ).toBe(true);
    expect(state.active()).toEqual(["fabric_exec"]);

    expect(ownership.apply(true, new Set(["ask_user_question", "deploy_release"]))).toBe(
      false,
    );
    expect(state.setActiveTools).toHaveBeenCalledOnce();
  });

  it("rehides extension tools that a refresh re-activated while full mode stays active", () => {
    const state = hostWith(["fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true, new Set(["ask_user_question"]));
    state.host.setActiveTools(["fabric_exec", "ask_user_question"]);
    expect(ownership.apply(true, new Set(["ask_user_question"]))).toBe(true);
    expect(state.active()).toEqual(["fabric_exec"]);
  });

  it("re-exposes extension tools removed from the hidden set while full mode stays active", () => {
    const state = hostWith(["read", "ask_user_question", "deploy_release", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true, new Set(["ask_user_question", "deploy_release"]));
    expect(state.active()).toEqual(["fabric_exec"]);

    expect(ownership.apply(true, new Set(["deploy_release"]))).toBe(true);
    expect(state.active()).toEqual(["fabric_exec", "ask_user_question"]);
  });

  it("restores hidden extension tools when full code mode is released", () => {
    const state = hostWith(["read", "ask_user_question", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true, new Set(["ask_user_question"]));
    expect(state.active()).toEqual(["fabric_exec"]);

    expect(ownership.apply(false)).toBe(true);
    expect(state.active()).toEqual(["read", "ask_user_question", "fabric_exec"]);

    expect(ownership.release()).toBe(false);
  });
});

describe("createToolOwnershipReassertion", () => {
  it("no-ops scheduled reassertions that run before the host is ready", async () => {
    // Registry rebuilds fire during extension load, before session_start
    // initializes Fabric state; the deferred reassertion must not read config.
    let ready = false;
    const apply = vi.fn();
    const { schedule } = createToolOwnershipReassertion({
      ready: () => ready,
      active: () => true,
      hiddenNames: () => new Set(["ask_user_question"]),
      apply,
    });

    schedule();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    ready = true;
    schedule();
    await Promise.resolve();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(new Set(["ask_user_question"]));
  });

  it("dedupes simultaneous schedules and skips reassertion while inactive", async () => {
    let active = false;
    const apply = vi.fn();
    const { reassert, schedule } = createToolOwnershipReassertion({
      ready: () => true,
      active: () => active,
      hiddenNames: () => new Set(["deploy_release"]),
      apply,
    });

    schedule();
    schedule();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    active = true;
    reassert();
    expect(apply).toHaveBeenCalledOnce();
  });
});
