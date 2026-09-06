import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "../src/core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const provider = (
  value: string,
  options: { close?: () => void | Promise<void>; wait?: Promise<void> } = {},
): FabricProvider => ({
  name: "demo",
  description: `Demo ${value}`,
  async list() {
    return [await this.describe("echo", context)].filter((entry) => entry !== undefined);
  },
  async describe(name) {
    return name === "echo"
      ? {
          name: "echo",
          description: `Echo ${value}`,
          inputSchema: { type: "object", additionalProperties: false },
          risk: "read",
          effect: { kind: "none", resources: [`demo:${value}`], ordering: "commutative" },
        }
      : undefined;
  },
  async invoke() {
    await options.wait;
    return value;
  },
  async close() {
    await options.close?.();
  },
});

const invoke = (
  registry: ActionRegistry,
  invocationContext: FabricInvocationContext = context,
): Promise<unknown> =>
  registry.invoke("demo.echo", {}, {
    ...invocationContext,
    approve: async () => {},
    audits: [],
    maxResultChars: 10_000,
  });

describe("provider binding generations", () => {
  it("keeps a retiring provider alive for committed views and protects replacements from stale leases", async () => {
    const registry = new ActionRegistry();
    const firstClosed = vi.fn();
    const first = registry.mount(provider("first", { close: firstClosed }));
    const pinned = await registry.acquireCapabilityView(["demo.echo"], context);
    expect(pinned.satisfied).toBe(true);
    await expect(registry.describe("demo.uncommitted", {
      ...context,
      capabilityView: pinned.view!,
    })).rejects.toThrow("outside the committed view");

    const second = registry.mount(provider("second"), { overwrite: true });
    expect(await invoke(registry)).toBe("second");
    expect(await invoke(registry, { ...context, capabilityView: pinned.view! })).toBe("first");
    expect(firstClosed).not.toHaveBeenCalled();

    await first.release();
    expect(registry.has("demo")).toBe(true);
    expect(await invoke(registry)).toBe("second");
    expect(firstClosed).not.toHaveBeenCalled();

    await pinned.release();
    expect(firstClosed).toHaveBeenCalledOnce();
    await second.release();
  });

  it("does not close a replaced provider until an in-flight invocation settles", async () => {
    const registry = new ActionRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const closed = vi.fn();
    registry.register(provider("first", { wait: gate, close: closed }));
    const pending = invoke(registry);
    await Promise.resolve();

    registry.register(provider("second"), { overwrite: true });
    expect(closed).not.toHaveBeenCalled();
    release();
    expect(await pending).toBe("first");
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    await registry.close();
  });

  it("records overlapping effect footprints and enforces strict policy", async () => {
    const registry = new ActionRegistry();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    registry.register({
      name: "effects",
      description: "Effect conflicts",
      async list() { return []; },
      async describe(name) {
        if (!["first", "second", "distinct", "unknown"].includes(name)) return undefined;
        return {
          name,
          description: name,
          inputSchema: { type: "object", additionalProperties: false },
          risk: "write",
          effect: {
            kind: "transactional",
            ...(name === "unknown"
              ? {}
              : { resources: [name === "distinct" ? "workspace:b" : "workspace:a"] }),
            ordering: "ordered",
          },
        };
      },
      async invoke(name) {
        if (name === "first") {
          started();
          await gate;
        }
        return name;
      },
    });
    const call = (
      name: string,
      effectPolicy: "advisory" | "strict",
      audits: Parameters<ActionRegistry["invoke"]>[2]["audits"] = [],
    ) => registry.invoke(`effects.${name}`, {}, {
      ...context,
      effectPolicy,
      approve: async () => {},
      audits,
      maxResultChars: 10_000,
    });

    const first = call("first", "advisory");
    await active;
    const advisoryAudits: Parameters<ActionRegistry["invoke"]>[2]["audits"] = [];
    await expect(call("second", "advisory", advisoryAudits)).resolves.toBe("second");
    expect(advisoryAudits[0]?.effectConflicts).toEqual([{
      withRef: "effects.first",
      resources: ["workspace:a"],
      reason: "shared_resource",
    }]);
    await expect(call("second", "strict")).rejects.toThrow(
      "effects.first [workspace:a] (shared noncommutative resource)",
    );
    await expect(call("unknown", "strict")).rejects.toThrow(
      "effects.first [*] (unknown resource footprint; declare resources and ordering)",
    );
    const distinctAudits: Parameters<ActionRegistry["invoke"]>[2]["audits"] = [];
    await expect(call("distinct", "strict", distinctAudits)).resolves.toBe("distinct");
    expect(distinctAudits[0]?.effectConflicts).toBeUndefined();
    release();
    await first;
    await registry.close();
  });

  it("allows explicitly commutative calls on the same resource", async () => {
    const registry = new ActionRegistry();
    let release!: () => void;
    let started!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    registry.register({
      name: "commute",
      description: "Commutative effects",
      async list() { return []; },
      async describe(name) {
        return name === "write"
          ? {
              name,
              description: name,
              inputSchema: { type: "object", additionalProperties: false },
              risk: "write",
              effect: {
                kind: "transactional",
                resources: ["workspace:a"],
                ordering: "commutative",
              },
            }
          : undefined;
      },
      async invoke() {
        calls++;
        if (calls === 1) {
          started();
          await gate;
        }
        return calls;
      },
    });
    const invokeCommutative = (audits: Parameters<ActionRegistry["invoke"]>[2]["audits"]) =>
      registry.invoke("commute.write", {}, {
        ...context,
        effectPolicy: "strict",
        approve: async () => {},
        audits,
        maxResultChars: 10_000,
      });

    const first = invokeCommutative([]);
    await active;
    const secondAudits: Parameters<ActionRegistry["invoke"]>[2]["audits"] = [];
    await expect(invokeCommutative(secondAudits)).resolves.toBe(2);
    expect(secondAudits[0]?.effectConflicts).toBeUndefined();
    release();
    await first;
    await registry.close();
  });

  it("keeps staged providers hidden until an atomic activation", async () => {
    const registry = new ActionRegistry();
    const lease = registry.mount(provider("staged"), { staged: true });
    expect(registry.has("demo")).toBe(false);
    expect(registry.providers()).toEqual([]);
    expect(() => registry.register(provider("intruder"))).toThrow(
      "Fabric provider already registered: demo",
    );

    expect(registry.activateProviderBindings([lease.bindingId])).toEqual([]);
    expect(lease.active).toBe(true);
    expect(await invoke(registry)).toBe("staged");
    await lease.release();
  });

  it("only lets an explicitly overwriting staged binding replace a current provider", async () => {
    const registry = new ActionRegistry();
    registry.register(provider("current"));
    expect(() => registry.mount(provider("implicit"), { staged: true })).toThrow(
      "Fabric provider already registered: demo",
    );

    const replacement = registry.mount(provider("replacement"), {
      staged: true,
      overwrite: true,
    });
    expect(await invoke(registry)).toBe("current");
    expect(registry.activateProviderBindings([replacement.bindingId])).toHaveLength(1);
    expect(await invoke(registry)).toBe("replacement");
    await replacement.release();
    await registry.close();
  });

  it("acquires scoped actions with schema checks and a single-shot disposer", async () => {
    const registry = new ActionRegistry();
    const dispose = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    registry.register({
      name: "lease",
      description: "Scoped lease",
      async list() { return [(await this.describe("open", context))!]; },
      async describe(name) {
        return name === "open"
          ? {
              name: "open",
              description: "Open a lease",
              inputSchema: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
                additionalProperties: false,
              },
              risk: "execute",
              effect: { kind: "scoped", resources: ["lease:key"], ordering: "ordered" },
            }
          : undefined;
      },
      async invoke() { throw new Error("use acquire"); },
      async acquire(_name, args) { return { value: args.key, dispose }; },
      close,
    });
    const pinned = await registry.acquireCapabilityView(["lease.open"], context);
    await expect(registry.invoke("lease.open", { key: "value" }, {
      ...context,
      capabilityView: pinned.view!,
      approve: async () => {},
      audits: [],
      maxResultChars: 10_000,
    })).rejects.toThrow("requires a supervised acquisition context");

    await expect(registry.acquireScoped("lease.open", {}, {
      ...context,
      capabilityView: pinned.view!,
    })).rejects.toThrow("Invalid arguments");
    const acquired = await registry.acquireScoped("lease.open", { key: "value" }, {
      ...context,
      capabilityView: pinned.view!,
    });
    expect(acquired.value).toBe("value");
    registry.unregister("lease");
    await pinned.release();
    expect(close).not.toHaveBeenCalled();
    await Promise.all([acquired.dispose(), acquired.dispose()]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    await registry.close();
  });

  it("rejects descriptor drift in a committed view", async () => {
    const registry = new ActionRegistry();
    let description = "before";
    registry.register({
      ...provider("value"),
      async describe(name) {
        return name === "echo"
          ? {
              name: "echo",
              description,
              inputSchema: { type: "object", additionalProperties: false },
              risk: "read",
            }
          : undefined;
      },
    });
    const pinned = await registry.acquireCapabilityView(["demo.echo"], context);
    description = "after";
    await expect(invoke(registry, { ...context, capabilityView: pinned.view! }))
      .rejects.toThrow("Fabric capability descriptor changed: demo.echo");
    await pinned.release();
    await registry.close();
  });
});
