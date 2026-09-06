import { describe, expect, it, vi } from "vitest";
import { FabricActivityStore } from "../src/activity/store.js";

describe("FabricActivityStore", () => {
  it("tracks dynamic phases, calls, entities, metrics, and custom items", () => {
    const store = new FabricActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.start("run-1", { name: "Repository audit", description: "Inspect every package" });
    const discover = store.phase("run-1", { name: "Discover", total: 2 });
    store.beginCall("run-1", {
      callId: "call-1",
      ref: "agents.run",
      args: { name: "package-a", task: "Audit package A" },
    });
    store.updateCall("run-1", "call-1", {
      type: "entity",
      id: "agent-1",
      kind: "agent",
      name: "package-a",
    });
    store.updateCall("run-1", "call-1", {
      type: "metrics",
      tokens: 1200,
      toolCalls: 4,
    });
    store.finishCall("run-1", "call-1", {
      success: true,
      result: {
        id: "agent-1",
        status: "completed",
        toolCalls: 5,
        usage: { input: 900, output: 500, cost: 0.01 },
      },
    });
    store.upsertItem("run-1", {
      id: "inventory",
      label: "Inventory packages",
      phase: discover.id,
      status: "completed",
      completed: 2,
      total: 2,
    });
    store.event("run-1", { message: "Inventory complete", level: "success" });

    const audit = store.phase("run-1", { name: "Audit", total: 4 });
    store.upsertItem("run-1", {
      id: "batch",
      label: "Audit packages",
      status: "running",
      completed: 1,
      total: 4,
    });

    let run = store.get("run-1");
    expect(run).toMatchObject({
      name: "Repository audit",
      status: "running",
      currentPhaseId: audit.id,
      phases: [
        { name: "Discover", status: "completed", total: 2 },
        { name: "Audit", status: "running", total: 4 },
      ],
      calls: [
        {
          label: "package-a",
          status: "completed",
          entityId: "agent-1",
          metrics: { tokens: 1400, toolCalls: 5, cost: 0.01 },
        },
      ],
      events: [{ message: "Inventory complete", level: "success" }],
    });

    store.finish("run-1", true);
    run = store.get("run-1");
    expect(run?.status).toBe("completed");
    expect(run?.phases[1]?.status).toBe("completed");
    expect(run?.items.find((item) => item.id === "batch")?.status).toBe("completed");
    expect(listener).toHaveBeenCalled();
  });

  it("keeps item phase ownership stable unless an update explicitly moves it", () => {
    const store = new FabricActivityStore();
    store.start("run-item-phase");
    const launch = store.phase("run-item-phase", { name: "Launch" });
    store.upsertItem("run-item-phase", {
      id: "worker",
      label: "Worker",
      status: "running",
    });

    const collect = store.phase("run-item-phase", { name: "Collect" });
    store.upsertItem("run-item-phase", {
      id: "worker",
      label: "Worker",
      status: "completed",
    });
    expect(store.get("run-item-phase")?.items[0]?.phaseId).toBe(launch.id);

    store.upsertItem("run-item-phase", {
      id: "worker",
      label: "Worker",
      status: "completed",
      phase: collect.id,
    });
    expect(store.get("run-item-phase")?.items[0]?.phaseId).toBe(collect.id);
  });

  it("summarizes finished call results into a detail field", () => {
    const store = new FabricActivityStore();
    store.start("run-d");
    store.beginCall("run-d", { callId: "bash-1", ref: "omp.bash", args: { command: "seq 1 3" } });
    store.updateCallArgs("run-d", "bash-1", { command: "export SAFE=true\nseq 1 3" });
    store.finishCall("run-d", "bash-1", { success: true, result: { ok: true, output: "line1\nline2" } });
    store.beginCall("run-d", { callId: "read-1", ref: "omp.read", args: { path: "/a.ts" } });
    store.finishCall("run-d", "read-1", {
      success: true,
      result: "export const x = 1;",
      preview: { details: { truncation: { truncated: false } } },
    });
    store.beginCall("run-d", { callId: "fail-1", ref: "omp.bash", args: {} });
    store.finishCall("run-d", "fail-1", { success: false, error: "boom" });

    const run = store.get("run-d");
    const bash = run?.calls.find((c) => c.id === "bash-1");
    expect(bash?.args).toEqual({ command: "export SAFE=true\nseq 1 3" });
    expect(bash?.result).toEqual({ ok: true, output: "line1\nline2" });
    expect(bash?.detail).toBe("line1 line2");
    const read = run?.calls.find((c) => c.id === "read-1");
    expect(read?.detail).toBe("export const x = 1;");
    expect(read?.preview).toEqual({ details: { truncation: { truncated: false } } });
    const failed = run?.calls.find((c) => c.id === "fail-1");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
    expect(failed?.detail).toBeUndefined();
  });

  it("bounds retained call payloads and run history", () => {
    const store = new FabricActivityStore();
    const large = "x".repeat(100_000);
    store.start("bounded");
    store.beginCall("bounded", {
      callId: "large",
      ref: "omp.write",
      args: { path: "/tmp/large.txt", content: large },
    });
    store.finishCall("bounded", "large", {
      success: true,
      result: { ok: true, output: large },
      preview: { diff: large },
    });

    const call = store.get("bounded")?.calls[0];
    expect(call?.label).toContain("/tmp/large.txt");
    expect(call?.args).toMatchObject({ fabricTruncated: true });
    expect(call?.result).toMatchObject({ fabricTruncated: true });
    expect(call?.preview).toMatchObject({ fabricTruncated: true });
    expect(JSON.stringify(call).length).toBeLessThan(200_000);

    store.finish("bounded", true);
    for (let index = 0; index < 30; index++) {
      store.start(`run-${index}`);
      store.finish(`run-${index}`, true);
    }
    expect(store.runs()).toHaveLength(24);
    expect(store.get("bounded")).toBeUndefined();
  });

  it("reopens a completed run for boundary continuation activity", () => {
    const store = new FabricActivityStore();
    store.start("run-boundary");
    store.beginCall("run-boundary", {
      callId: "prewalk",
      ref: "agents.handoff",
      args: { name: "Deferred handoff" },
    });
    store.finishCall("run-boundary", "prewalk", {
      success: true,
      result: { status: "deferred" },
    });
    store.finish("run-boundary", true);

    store.resume("run-boundary");
    store.beginCall("run-boundary", {
      callId: "prewalk",
      ref: "agents.handoff",
      args: { name: "Prewalk trajectory executor" },
    });
    store.updateCall("run-boundary", "prewalk", {
      type: "entity",
      id: "child-1",
      kind: "agent",
      name: "Prewalk trajectory executor",
    });

    const resumed = store.get("run-boundary");
    expect(resumed).toMatchObject({
      status: "running",
      calls: [{ status: "running", entityId: "child-1", entityKind: "agent" }],
    });
    expect(resumed).not.toHaveProperty("finishedAt");
  });

  it("marks failed calls and cancelled executions", () => {
    const store = new FabricActivityStore();
    store.start("run-2");
    store.phase("run-2", { name: "Execute" });
    store.beginCall("run-2", { callId: "call-2", ref: "omp.bash", args: {} });
    store.finishCall("run-2", "call-2", { success: false, error: "command failed" });
    store.finish("run-2", false, "Execution cancelled");

    expect(store.get("run-2")).toMatchObject({
      status: "cancelled",
      phases: [{ status: "failed" }],
      calls: [{ status: "failed", error: "command failed" }],
    });
  });

  it("labels generic extension tool calls with their query argument", () => {
    const store = new FabricActivityStore();
    store.start("run-q");
    store.beginCall("run-q", {
      callId: "recall-1",
      ref: "extensions.vcc_recall",
      args: { query: "how do I recall X" },
    });
    const run = store.get("run-q");
    expect(run?.calls[0]?.label).toBe("extensions.vcc_recall · how do I recall X");
  });

  it("runSummaries strips payloads but keeps linkable metadata in run order", () => {
    const store = new FabricActivityStore();
    store.start("run-1", { name: "Loop" });
    const phase = store.phase("run-1", { name: "Scan", total: 1 });
    store.beginCall("run-1", {
      callId: "call-1",
      ref: "omp.read",
      args: { path: "src/a.ts", blob: "x".repeat(10_000) },
    });
    store.updateCall("run-1", "call-1", { type: "metrics", tokens: 42 });
    store.finishCall("run-1", "call-1", {
      success: true,
      result: { output: "y".repeat(20_000) },
      preview: { head: "z".repeat(5_000) },
    });
    store.upsertItem("run-1", {
      id: "item-1",
      label: "Scanned files",
      status: "running",
      data: { entries: [1, 2, 3] },
    });
    store.event("run-1", { message: "tick", data: { blob: "q".repeat(4_000) } });

    const [summary] = store.runSummaries();
    expect(summary?.status).toBe("running");
    expect(summary?.currentPhaseId).toBe(phase.id);
    const call = summary?.calls[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("args");
    expect(call).not.toHaveProperty("result");
    expect(call).not.toHaveProperty("preview");
    expect(call).toMatchObject({
      id: "call-1",
      ref: "omp.read",
      kind: "tool",
      status: "completed",
      metrics: { tokens: 42 },
    });
    expect(typeof call?.startedAt).toBe("number");
    expect(summary?.phases[0]?.name).toBe("Scan");
    expect(summary?.items[0]?.label).toBe("Scanned files");
    expect(summary?.items[0]).not.toHaveProperty("data");
    expect(summary?.events[0]?.message).toBe("tick");
    expect(summary?.events[0]).not.toHaveProperty("data");

    // Summaries are isolated: mutating them must not leak into the store.
    if (call?.metrics) call.metrics.tokens = -1;
    summary?.calls.push({ ...structuredClone(call!), id: "injected" });
    const again = store.runSummaries()[0];
    expect(again?.calls).toHaveLength(1);
    expect(again?.calls[0]?.metrics?.tokens).toBe(42);

    // Ordering parity with runs(): running runs sort first.
    store.start("run-2", { name: "Settled" });
    store.finish("run-2", true);
    expect(store.runSummaries()[0]?.id).toBe("run-1");

    // Full detail remains available through runs().
    const detailed = store.runs().find((run) => run.id === "run-1");
    expect(detailed?.calls[0]?.args).toMatchObject({ path: "src/a.ts" });
    expect(detailed?.items[0]?.data).toMatchObject({ entries: [1, 2, 3] });
  });

  it("falls back to a lexical name hint only when no display name is declared", () => {
    const store = new FabricActivityStore();

    const hinted = store.start("hint-1", {}, "Read config.ts");
    expect(hinted.name).toBe("Read config.ts");

    const declared = store.start("hint-2", { name: "Declared milestone" }, "Read config.ts");
    expect(declared.name).toBe("Declared milestone");

    const plain = store.start("hint-3");
    expect(plain.name).toBe("Fabric program");
  });
});

