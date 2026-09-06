import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  type FabricCallAudit,
} from "../src/core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";
import { FabricSpeculationStore } from "../src/speculation/store.js";
import type { FabricSpeculationReplay } from "../src/speculation/types.js";

interface Counter {
  invokeCalls: string[];
}

const provider = (counter: Counter): FabricProvider => ({
  name: "spec",
  description: "Speculation test provider",
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
      {
        name: "mutate",
        description: "Pretend to mutate something",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
          additionalProperties: false,
        },
        risk: "write" as const,
      },
    ];
  },
  async describe(name) {
    const list = await this.list({}, context);
    return list.find((descriptor) => descriptor.name === name);
  },
  async invoke(name, args) {
    counter.invokeCalls.push(`${name}:${String((args as { value?: string }).value ?? (args as { target?: string }).target ?? "")}`);
    return `ran:${name}:${String((args as { value?: string }).value ?? "")}`;
  },
});

const taggedProvider = (tag: string, counter: Counter): FabricProvider => {
  const base = provider(counter);
  return {
    ...base,
    async invoke(name, args) {
      const value = String((args as { value?: string }).value ?? "");
      counter.invokeCalls.push(`${name}:${value}`);
      return `${tag}:${value}`;
    },
  };
};

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const fullContext = (toolCallId: string, audits: FabricCallAudit[]) => ({
  ...context,
  parentToolCallId: toolCallId,
  approve: vi.fn(async () => {}),
  audits,
  maxResultChars: 10_000,
});

const launchSpeculation = async (
  registry: ActionRegistry,
  store: FabricSpeculationStore,
  toolCallId: string,
  ref: string,
  args: Record<string, unknown>,
): Promise<boolean> => {
  const replay: FabricSpeculationReplay = {};
  const spec = await registry.speculate(ref, args, { ...context, parentToolCallId: toolCallId }, replay);
  if (!spec) return false;
  return store.launch(toolCallId, ref, spec.preparedArgs, spec.execute, undefined, replay, spec.bindingToken);
};

describe("ActionRegistry speculation integration", () => {
  it("serves a pre-launched read without a second provider call", async () => {
    const counter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(provider(counter));
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, (action) => action.risk === "read");

    expect(await launchSpeculation(registry, store, "tc1", "spec.echo", { value: "hi" })).toBe(true);
    // The executor runs inside the store's launch microtask.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    const audits: FabricCallAudit[] = [];
    const ctx = fullContext("tc1", audits);
    const result = await registry.invoke("spec.echo", { value: "hi" }, ctx);
    expect(result).toBe("ran:echo:hi");
    // One provider call total: the speculative one. The real call was served.
    expect(counter.invokeCalls).toEqual(["echo:hi"]);
    expect(ctx.approve).toHaveBeenCalledOnce();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ ref: "spec.echo", success: true, speculated: true });
    expect(store.stats()).toMatchObject({ launched: 1, served: 1 });
    registry.endInvocation("tc1"); // no unserved entries -> nothing wasted
    expect(store.stats().wasted).toBe(0);
  });

  it("invalidates pending speculation when a mutating call executes", async () => {
    const counter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(provider(counter));
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, (action) => action.risk === "read");

    await launchSpeculation(registry, store, "tc1", "spec.echo", { value: "hi" });
    const audits: FabricCallAudit[] = [];
    // In-program mutation: bumps the epoch after the provider call completes.
    await registry.invoke("spec.mutate", { target: "t" }, fullContext("tc1", audits));
    const result = await registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", audits));
    expect(result).toBe("ran:echo:hi");
    // The stale speculation was discarded and the read re-executed for real.
    expect(counter.invokeCalls).toEqual(["echo:hi", "mutate:t", "echo:hi"]);
    expect(audits[1]).toMatchObject({ ref: "spec.echo", success: true });
    expect(audits[1]?.speculated).toBeUndefined();
    expect(store.stats()).toMatchObject({ launched: 1, served: 0, epochInvalidated: 1 });
  });

  it("falls back to a real call when the speculative read failed", async () => {
    const counter: Counter = { invokeCalls: [] };
    let failNext = true;
    const flaky = provider(counter);
    const originalInvoke = flaky.invoke.bind(flaky);
    flaky.invoke = (async (name: string, args: Record<string, unknown>, invocation: never) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient");
      }
      return originalInvoke(name, args, invocation);
    }) as FabricProvider["invoke"];
    const registry = new ActionRegistry();
    registry.register(flaky);
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, (action) => action.risk === "read");

    await launchSpeculation(registry, store, "tc1", "spec.echo", { value: "hi" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const result = await registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", []));
    expect(result).toBe("ran:echo:hi");
    expect(counter.invokeCalls).toEqual(["echo:hi"]); // only the real retry
    expect(store.stats()).toMatchObject({ served: 0, failed: 1 });
  });

  it("invalidates unpinned speculation when a provider binding changes", async () => {
    const oldCounter: Counter = { invokeCalls: [] };
    const newCounter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(taggedProvider("old", oldCounter));
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, () => true);
    expect(await launchSpeculation(registry, store, "tc1", "spec.echo", { value: "hi" })).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    registry.register(taggedProvider("new", newCounter), { overwrite: true });
    expect(await registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", []))).toBe(
      "new:hi",
    );
    expect(oldCounter.invokeCalls).toEqual(["echo:hi"]);
    expect(newCounter.invokeCalls).toEqual(["echo:hi"]);
    expect(store.stats()).toMatchObject({ served: 0, pending: 0 });
    await registry.close();
  });

  it("cannot serve a speculation resolved against a replaced binding", async () => {
    const oldCounter: Counter = { invokeCalls: [] };
    const newCounter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    let releaseDescribe: (() => void) | undefined;
    const base = taggedProvider("old", oldCounter);
    const slowOld: FabricProvider = {
      ...base,
      async describe(name, ctx) {
        await new Promise<void>((resolvePromise) => {
          releaseDescribe = resolvePromise;
        });
        return base.describe(name, ctx);
      },
    };
    registry.register(slowOld);
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, () => true);

    const replay: FabricSpeculationReplay = {};
    const speculationPromise = registry.speculate(
      "spec.echo",
      { value: "hi" },
      fullContext("tc1", []),
      replay,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(releaseDescribe).toBeDefined();

    // Replace the binding while speculate() is still awaiting describe().
    // reset() cannot abort a launch that has not happened yet, so the stale
    // entry is stored afterwards — keyed by the retired binding.
    registry.register(taggedProvider("new", newCounter), { overwrite: true });
    releaseDescribe!();
    const speculation = await speculationPromise;
    expect(speculation).toBeDefined();
    expect(
      store.launch(
        "tc1",
        "spec.echo",
        speculation!.preparedArgs,
        speculation!.execute,
        undefined,
        replay,
        speculation!.bindingToken,
      ),
    ).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    const result = await registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", []));
    expect(result).toBe("new:hi");
    // The stale launch may have executed as waste, but its result can never be
    // served: the real call resolved the replacement binding and missed.
    expect(newCounter.invokeCalls).toEqual(["echo:hi"]);
    expect(store.stats()).toMatchObject({ served: 0 });
    registry.endInvocation("tc1");
    expect(store.stats().pending).toBe(0);
    await registry.close();
  });

  it("speculates through the exact binding in a committed capability view", async () => {
    const oldCounter: Counter = { invokeCalls: [] };
    const newCounter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(taggedProvider("old", oldCounter));
    registry.setSpeculation(
      new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 }),
      () => true,
    );
    const pinned = await registry.acquireCapabilityView(["spec.echo"], context);
    expect(pinned.satisfied).toBe(true);
    registry.register(taggedProvider("new", newCounter), { overwrite: true });

    const replay: FabricSpeculationReplay = {};
    const speculation = await registry.speculate(
      "spec.echo",
      { value: "hi" },
      { ...context, capabilityView: pinned.view! },
      replay,
    );
    expect(speculation).toBeDefined();
    await expect(speculation!.execute(undefined)).resolves.toBe("old:hi");
    expect(oldCounter.invokeCalls).toEqual(["echo:hi"]);
    expect(newCounter.invokeCalls).toEqual([]);
    await pinned.release();
    await registry.close();
  });

  it("refuses to speculate when the eligibility gate declines", async () => {
    const counter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(provider(counter));
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, () => false);
    expect(await launchSpeculation(registry, store, "tc1", "spec.echo", { value: "hi" })).toBe(false);
    expect(counter.invokeCalls).toEqual([]);
  });

  it("drops invalid-argument speculations at prepare time", async () => {
    const counter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(provider(counter));
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, () => true);
    expect(
      await launchSpeculation(registry, store, "tc1", "spec.echo", { wrong: "args" }),
    ).toBe(false);
    expect(counter.invokeCalls).toEqual([]);
  });

  it("gives the model an identical result whether served from speculation or executed fresh", async () => {
    // Provider exercises every side channel so the comparison covers replay:
    // media blocks, argument updates, a preview, and a structured value.
    const richProvider = (): FabricProvider => ({
      name: "spec",
      description: "Speculation test provider",
      async list() {
        return [
          {
            name: "echo",
            description: "Echo with side channels (read)",
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
        const list = await this.list({}, ctx);
        return list.find((descriptor) => descriptor.name === name);
      },
      async invoke(_name, args, invocation) {
        const value = String((args as { value?: string }).value ?? "");
        invocation?.updateArguments?.({ value: `trimmed:${value}` });
        invocation?.attachMedia?.(
          [{ type: "image", data: "aGk=", mimeType: "image/png" }],
          "thumbnail",
        );
        invocation?.attachPreview?.({ kind: "preview", value });
        return { echo: value, nested: { ok: true, list: [1, 2] } };
      },
    });

    // Path A: plain invoke, no speculation anywhere.
    const registryA = new ActionRegistry();
    registryA.register(richProvider());
    const auditsA: FabricCallAudit[] = [];
    const resultA = await registryA.invoke(
      "spec.echo",
      { value: "hi" },
      fullContext("tc1", auditsA),
    );

    // Path B: speculation launched first, then the same invoke.
    const registryB = new ActionRegistry();
    registryB.register(richProvider());
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registryB.setSpeculation(store, () => true);
    expect(await launchSpeculation(registryB, store, "tc1", "spec.echo", { value: "hi" })).toBe(true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const auditsB: FabricCallAudit[] = [];
    const resultB = await registryB.invoke(
      "spec.echo",
      { value: "hi" },
      fullContext("tc1", auditsB),
    );

    // The value handed back to the program is identical.
    expect(resultB).toEqual(resultA);
    expect(auditsB[0]?.speculated).toBe(true);

    // Audits differ only in wall-clock markers and the observability flag.
    const stripVolatile = (audit: FabricCallAudit | undefined) => {
      if (!audit) return audit;
      const { startedAt, endedAt, speculated, nestedToolCallId, ...stable } =
        audit as FabricCallAudit & {
          startedAt?: number;
          endedAt?: number;
          speculated?: boolean;
          nestedToolCallId?: string;
        };
      void startedAt; void endedAt; void speculated; void nestedToolCallId;
      return stable;
    };
    expect(stripVolatile(auditsB[0])).toEqual(stripVolatile(auditsA[0]));
  });

  it("behaves identically with no speculation runtime attached", async () => {
    const counter: Counter = { invokeCalls: [] };
    const registry = new ActionRegistry();
    registry.register(provider(counter));
    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke("spec.echo", { value: "hi" }, fullContext("tc1", audits));
    expect(result).toBe("ran:echo:hi");
    expect(counter.invokeCalls).toEqual(["echo:hi"]);
    expect(audits[0]?.speculated).toBeUndefined();
  });
});
