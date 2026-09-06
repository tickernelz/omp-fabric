import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import { createFabricPersistedExecutionDetails } from "../src/audit/details.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";
import { FabricSpeculationStore } from "../src/speculation/store.js";
import { fabricSpeculationSummary } from "../src/speculation/summary.js";
import type { FabricSpeculationReplay } from "../src/speculation/types.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const echoProvider = (calls: string[]): FabricProvider => ({
  name: "spec",
  description: "Speculation observability provider",
  async list() {
    return [
      {
        name: "echo",
        description: "Echo a string (read)",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        risk: "read" as const,
      },
    ];
  },
  async describe(name, ctx) {
    return (await this.list({}, ctx)).find((descriptor) => descriptor.name === name);
  },
  async invoke(_name, args) {
    const value = String((args as { value?: string }).value ?? "");
    calls.push(value);
    return `ran:${value}`;
  },
});

const fullContext = (toolCallId: string, audits: FabricCallAudit[]) => ({
  ...context,
  parentToolCallId: toolCallId,
  approve: vi.fn(async () => {}),
  audits,
  maxResultChars: 10_000,
});

const launch = async (
  registry: ActionRegistry,
  store: FabricSpeculationStore,
  toolCallId: string,
  args: Record<string, unknown>,
): Promise<boolean> => {
  const replay: FabricSpeculationReplay = {};
  const speculation = await registry.speculate(
    "spec.echo",
    args,
    { ...context, parentToolCallId: toolCallId },
    replay,
  );
  if (!speculation) return false;
  return store.launch(
    toolCallId,
    "spec.echo",
    speculation.preparedArgs,
    speculation.execute,
    undefined,
    replay,
    speculation.bindingToken,
  );
};

const wired = () => {
  const calls: string[] = [];
  const registry = new ActionRegistry();
  registry.register(echoProvider(calls));
  const store = new FabricSpeculationStore({
    maxConcurrent: 4,
    maxEntries: 8,
    entryTtlMs: 60_000,
  });
  registry.setSpeculation(store, (action) => action.risk === "read");
  return { calls, registry, store };
};

describe("speculation miss path", () => {
  it("discards a speculation whose arguments do not match the real call", async () => {
    const { calls, registry, store } = wired();
    expect(await launch(registry, store, "tc1", { value: "guessed" })).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke(
      "spec.echo",
      { value: "actual" },
      fullContext("tc1", audits),
    );

    expect(result).toBe("ran:actual");
    expect(audits[0]?.speculated).toBeUndefined();
    expect(calls).toEqual(["guessed", "actual"]);
    expect(store.stats()).toMatchObject({ launched: 1, served: 0, absent: 1 });

    registry.endInvocation("tc1");
    expect(store.stats()).toMatchObject({ wasted: 1, pending: 0 });
    expect(calls).toEqual(["guessed", "actual"]);
  });

  it("counts an unspeculated read as a miss without touching its result", async () => {
    const { calls, registry, store } = wired();
    const audits: FabricCallAudit[] = [];
    expect(
      await registry.invoke("spec.echo", { value: "cold" }, fullContext("tc1", audits)),
    ).toBe("ran:cold");
    expect(calls).toEqual(["cold"]);
    expect(audits[0]?.speculated).toBeUndefined();
    expect(store.stats()).toMatchObject({ launched: 0, served: 0, absent: 1 });
  });
});

describe("speculation observability", () => {
  it("reports session counters through the registry", async () => {
    const { registry, store } = wired();
    expect(registry.speculationStats()).toMatchObject({ launched: 0, served: 0, absent: 0 });
    await launch(registry, store, "tc1", { value: "hi" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", []));
    expect(registry.speculationStats()).toMatchObject({ launched: 1, served: 1, absent: 0 });
  });

  it("summarizes launched/hit/missed/discarded for the run details", () => {
    expect(fabricSpeculationSummary(undefined)).toBeUndefined();
    expect(
      fabricSpeculationSummary({
        launched: 0,
        served: 0,
        absent: 0,
        epochInvalidated: 0,
        freshnessInvalidated: 0,
        failed: 0,
        wasted: 0,
        skipped: 0,
      }),
    ).toBeUndefined();
    expect(
      fabricSpeculationSummary({
        launched: 5,
        served: 2,
        absent: 1,
        epochInvalidated: 1,
        freshnessInvalidated: 1,
        failed: 1,
        wasted: 2,
        skipped: 3,
      }),
    ).toEqual({ launched: 5, hit: 2, missed: 4, discarded: 5 });
  });

  it("persists the speculated flag and the summary into fabric_exec details", () => {
    const details = createFabricPersistedExecutionDetails({
      success: true,
      trace: {
        kind: "omp-fabric.execution",
        version: 1,
        outcome: "succeeded",
        phases: [],
        operations: [],
        counts: {
          droppedValues: 0,
          truncatedValues: 0,
          redactedValues: 0,
          droppedOperations: 0,
        },
      },
      audits: [{ ref: "omp.read", success: true, speculated: true }],
      speculation: { launched: 1, hit: 1, missed: 0, discarded: 0 },
    });
    expect(details.audits[0]).toMatchObject({ ref: "omp.read", speculated: true });
    expect(details.speculation).toEqual({ launched: 1, hit: 1, missed: 0, discarded: 0 });
  });
});

describe("speculation launch barrier", () => {
  it("serves a speculation whose launch is still resolving when the real call arrives", async () => {
    const calls: string[] = [];
    const registry = new ActionRegistry();
    let releaseDescribe: (() => void) | undefined;
    const base = echoProvider(calls);
    registry.register({
      ...base,
      async describe(name, ctx) {
        if (releaseDescribe === undefined) {
          await new Promise<void>((resolvePromise) => {
            releaseDescribe = resolvePromise;
          });
        }
        return base.describe(name, ctx);
      },
    });
    const store = new FabricSpeculationStore({
      maxConcurrent: 4,
      maxEntries: 8,
      entryTtlMs: 60_000,
    });
    registry.setSpeculation(store, (action) => action.risk === "read");

    const launching = launch(registry, store, "tc1", { value: "hi" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(releaseDescribe).toBeDefined();

    const audits: FabricCallAudit[] = [];
    const invoking = registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", audits));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    releaseDescribe!();

    expect(await launching).toBe(true);
    expect(await invoking).toBe("ran:hi");
    expect(audits[0]?.speculated).toBe(true);
    expect(calls).toEqual(["hi"]);
    expect(store.stats()).toMatchObject({ launched: 1, served: 1, absent: 0 });
  });

  it("gives up on a launch that never registers instead of blocking the call", async () => {
    const { calls, registry, store } = wired();
    const release = store.beginLaunch("tc1");
    const started = Date.now();
    expect(
      await registry.invoke("spec.echo", { value: "cold" }, fullContext("tc1", [])),
    ).toBe("ran:cold");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toEqual(["cold"]);
    release();
  });
});
