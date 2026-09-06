import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type {
  FabricComponentContext,
  FabricComponentDefinition,
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";

const invocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "test",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const echoProvider = (
  name = "svc",
  value = "ok",
  close?: () => void,
): FabricProvider => ({
  name,
  description: `${name} service`,
  async list() {
    return [{
      name: "echo",
      description: "Echo a value",
      inputSchema: { type: "object", additionalProperties: false },
      risk: "read",
      effect: { kind: "none", ordering: "commutative" },
    }];
  },
  async describe(action) {
    return action === "echo" ? (await this.list({}, invocationContext()))[0] : undefined;
  },
  async invoke() {
    return value;
  },
  async close() { close?.(); },
});

const entry = (id: string, component = id) => ({ id, component });

describe("FabricComponentSupervisor", () => {
  it("waits for exact capabilities and activates against a committed view", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const states: string[] = [];
    supervisor.subscribe(() => {
      const state = supervisor.list().find((component) => component.id === "consumer")?.state;
      if (state) states.push(state);
    });
    const events: string[] = [];
    const definition: FabricComponentDefinition = {
      name: "consumer",
      requires: ["svc.echo", { ref: "missing.optional", optional: true }],
      async activate(context) {
        events.push(String(await context.call("svc.echo")));
        return () => { events.push("cleanup"); };
      },
    };

    expect(await supervisor.start(entry("consumer"), definition)).toMatchObject({
      state: "waiting",
      missing: ["svc.echo"],
      optionalMissing: ["missing.optional"],
    });
    registry.register(echoProvider());
    await supervisor.settle();

    expect(supervisor.status("consumer")).toMatchObject({
      state: "active",
      missing: [],
      optionalMissing: ["missing.optional"],
    });
    expect(supervisor.status("consumer").targetDigest).toBeTruthy();
    expect(events).toEqual(["ok"]);
    await supervisor.stop("consumer");
    expect(events).toEqual(["ok", "cleanup"]);
    expect(states).toContain("disposed");
    await registry.close();
  });

  it("keeps declaration cycles waiting and reports their exact path", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await supervisor.start(entry("alpha"), {
      name: "alpha",
      requires: ["beta.echo"],
      provides: ["alpha"],
      activate(context) { context.provide(echoProvider("alpha")); },
    });
    await supervisor.start(entry("beta"), {
      name: "beta",
      requires: ["alpha.echo"],
      provides: ["beta"],
      activate(context) { context.provide(echoProvider("beta")); },
    });

    expect(supervisor.status("alpha")).toMatchObject({
      state: "waiting",
      missing: ["beta.echo"],
    });
    expect(supervisor.status("beta")).toMatchObject({
      state: "waiting",
      missing: ["alpha.echo"],
    });
    expect(supervisor.graph().cycles).toEqual([["alpha", "beta"]]);
    await supervisor.close();
    await registry.close();
  });

  it("retires providers, unloads dependents, then releases owner effects", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    const owner: FabricComponentDefinition = {
      name: "owner",
      provides: ["svc"],
      activate(context) {
        context.provide(echoProvider("svc", "owned", () => { events.push("provider-close"); }));
        return () => { events.push("owner-cleanup"); };
      },
    };
    const dependent: FabricComponentDefinition = {
      name: "dependent",
      requires: ["svc.echo"],
      activate(context) {
        events.push("dependent-start");
        return async () => {
          events.push(`dependent-teardown:${String(await context.call("svc.echo"))}`);
          events.push("dependent-cleanup");
        };
      },
    };

    await supervisor.start(entry("owner"), owner);
    await supervisor.start(entry("dependent"), dependent);
    expect(registry.has("svc")).toBe(true);
    await supervisor.stop("owner");
    await supervisor.settle();

    expect(events).toEqual([
      "dependent-start",
      "dependent-teardown:owned",
      "dependent-cleanup",
      "owner-cleanup",
      "provider-close",
    ]);
    expect(registry.has("svc")).toBe(false);
    expect(supervisor.status("dependent")).toMatchObject({
      state: "waiting",
      missing: ["svc.echo"],
    });
    await supervisor.close();
    await registry.close();
  });

  it("settles async activation, rolls back a stale target, and retries", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activationStarted = new Promise<void>((resolve) => { started = resolve; });
    registry.register(echoProvider("svc", "first"));

    const activation = supervisor.start(entry("drift"), {
      name: "drift",
      requires: ["svc.echo"],
      async activate(context) {
        const value = String(await context.call("svc.echo"));
        events.push(`start:${value}`);
        started();
        await gate;
        return () => { events.push(`cleanup:${value}`); };
      },
    });
    await activationStarted;
    registry.register(echoProvider("svc", "second"), { overwrite: true });
    release();
    await activation;
    await supervisor.settle();

    expect(supervisor.status("drift")).toMatchObject({ state: "active" });
    expect(events).toEqual(["start:first", "cleanup:first", "start:second"]);
    await supervisor.close();
    await registry.close();
  });

  it("rolls back a failed replacement to the previous revision", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    const stable: FabricComponentDefinition = {
      name: "service",
      activate() {
        events.push("stable-start");
        return () => { events.push("stable-cleanup"); };
      },
    };
    const broken: FabricComponentDefinition = {
      name: "service",
      activate() {
        events.push("broken-start");
        throw new Error("candidate failed");
      },
    };

    await supervisor.start(entry("service"), stable);
    await expect(supervisor.replace("service", entry("service"), broken))
      .rejects.toThrow("candidate failed; previous revision restored");
    expect(supervisor.status("service")).toMatchObject({ state: "active", revision: 3 });
    expect(events).toEqual([
      "stable-start",
      "stable-cleanup",
      "broken-start",
      "stable-start",
    ]);
    await supervisor.close();
    await registry.close();
  });

  it("reconciles active components when a provider descriptor changes in place", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let description = "version one";
    let notify = () => {};
    registry.register({
      name: "mutable",
      description: "Mutable catalog",
      async list() { return [(await this.describe("read", invocationContext()))!]; },
      async describe(name) {
        return name === "read"
          ? {
              name: "read",
              description,
              inputSchema: { type: "object", additionalProperties: false },
              risk: "read",
            }
          : undefined;
      },
      async invoke() { return description; },
      subscribeCatalog(listener) { notify = listener; return () => { notify = () => {}; }; },
    });
    await supervisor.start(entry("catalog-user"), {
      name: "catalog-user",
      requires: ["mutable.read"],
      activate() {
        events.push(`start:${description}`);
        return () => { events.push(`stop:${description}`); };
      },
    });
    const firstDigest = supervisor.status("catalog-user").targetDigest;
    description = "version two";
    notify();
    await supervisor.settle();

    expect(events).toEqual([
      "start:version one",
      "stop:version two",
      "start:version two",
    ]);
    expect(supervisor.status("catalog-user").targetDigest).not.toBe(firstDigest);
    await supervisor.close();
    await registry.close();
  });

  it("automatically disposes scoped acquisitions", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    registry.register({
      name: "lease",
      description: "Lease provider",
      async list() { return [(await this.describe("open", invocationContext()))!]; },
      async describe(name) {
        return name === "open"
          ? {
              name: "open",
              description: "Open lease",
              inputSchema: { type: "object", additionalProperties: false },
              risk: "execute",
              effect: { kind: "scoped", resources: ["lease"], ordering: "ordered" },
            }
          : undefined;
      },
      async invoke() { throw new Error("use acquire"); },
      async acquire() {
        events.push("acquire");
        return { value: "resource", dispose: () => { events.push("release"); } };
      },
    });
    await supervisor.start(entry("lease-user"), {
      name: "lease-user",
      requires: ["lease.open"],
      guarantee: "revertible",
      async activate(context) {
        events.push(String(await context.acquire("lease.open")));
        return () => { events.push("owner-cleanup"); };
      },
    });
    await supervisor.stop("lease-user");
    expect(events).toEqual(["acquire", "resource", "owner-cleanup", "release"]);
    await registry.close();
  });

  it("rejects emission effects from revertible components", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    registry.register({
      name: "emit",
      description: "Emission provider",
      async list() { return [(await this.describe("write", invocationContext()))!]; },
      async describe(name) {
        return name === "write"
          ? {
              name: "write",
              description: "Emit a write",
              inputSchema: { type: "object", additionalProperties: false },
              risk: "write",
            }
          : undefined;
      },
      async invoke() { return "written"; },
    });

    await expect(supervisor.start(entry("safe"), {
      name: "safe",
      requires: ["emit.write"],
      guarantee: "revertible",
      async activate(context) { await context.call("emit.write"); },
    })).rejects.toThrow("cannot emit non-revertible action emit.write");
    expect(supervisor.status("safe").state).toBe("failed");
    await supervisor.close();
    await registry.close();
  });

  it("quarantines activation when setup rollback cleanup also fails", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await expect(supervisor.start(entry("broken-setup"), {
      name: "broken-setup",
      async *activate() {
        yield () => { throw new Error("rollback leaked"); };
        throw new Error("activation failed");
      },
    })).rejects.toThrow("setup and rollback failed");
    expect(supervisor.status("broken-setup")).toMatchObject({
      state: "quarantined",
      cleanupErrors: ["component:activate: rollback leaked"],
    });
    await supervisor.close();
    await registry.close();
  });

  it("rejects overlapping component provisions before disturbing either fiber", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    await supervisor.start(entry("alpha"), {
      name: "alpha",
      provides: ["svc"],
      activate(context) {
        context.provide(echoProvider("svc"));
        return () => { events.push("alpha-cleanup"); };
      },
    });
    await supervisor.start(entry("beta"), {
      name: "beta",
      activate() { return () => { events.push("beta-cleanup"); }; },
    });

    await expect(supervisor.start(entry("gamma"), {
      name: "gamma",
      provides: ["svc"],
      activate(context) { context.provide(echoProvider("svc")); },
    })).rejects.toThrow("declare the same providers: svc");
    await expect(supervisor.replace("beta", entry("beta"), {
      name: "beta",
      provides: ["svc"],
      activate(context) { context.provide(echoProvider("svc")); },
    })).rejects.toThrow("declare the same providers: svc");

    expect(supervisor.status("alpha").state).toBe("active");
    expect(supervisor.status("beta").state).toBe("active");
    expect(events).toEqual([]);
    await supervisor.close();
    await registry.close();
  });

  it("reserves staged provision names and heals externally retired provisions", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    let release!: () => void;
    let staged!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provisionStaged = new Promise<void>((resolve) => { staged = resolve; });
    let activations = 0;
    const activation = supervisor.start(entry("owner"), {
      name: "owner",
      provides: ["svc"],
      async activate(context) {
        activations++;
        context.provide(echoProvider("svc", `generation-${activations}`));
        if (activations === 1) {
          staged();
          await gate;
        }
      },
    });
    await provisionStaged;
    expect(() => registry.register(echoProvider("svc", "intruder"))).toThrow(
      "Fabric provider already registered: svc",
    );
    release();
    await activation;
    expect(await registry.invoke("svc.echo", {}, {
      ...invocationContext(),
      approve: async () => {},
      audits: [],
      maxResultChars: 10_000,
    })).toBe("generation-1");

    registry.unregister("svc");
    await supervisor.settle();
    expect(supervisor.status("owner").state).toBe("active");
    expect(activations).toBe(2);
    expect(await registry.invoke("svc.echo", {}, {
      ...invocationContext(),
      approve: async () => {},
      audits: [],
      maxResultChars: 10_000,
    })).toBe("generation-2");
    await supervisor.close();
    await registry.close();
  });

  it("diverts stale generator continuations and retries against the new target", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activationStarted = new Promise<void>((resolve) => { started = resolve; });
    registry.register(echoProvider("svc", "first"));

    const activation = supervisor.start(entry("iterated"), {
      name: "iterated",
      requires: ["svc.echo"],
      async *activate(context) {
        const value = String(await context.call("svc.echo"));
        events.push(`start:${value}`);
        if (value === "first") {
          started();
          await gate;
        }
        try {
          yield () => { events.push(`cleanup:${value}`); };
          events.push(`after:${value}`);
        } finally {
          events.push(`finally:${value}`);
        }
      },
    });
    await activationStarted;
    registry.register(echoProvider("svc", "second"), { overwrite: true });
    release();
    await activation;
    await supervisor.settle();

    expect(supervisor.status("iterated").state).toBe("active");
    expect(events).toEqual([
      "start:first",
      "finally:first",
      "cleanup:first",
      "start:second",
      "after:second",
      "finally:second",
    ]);
    await supervisor.close();
    expect(events.at(-1)).toBe("cleanup:second");
    await registry.close();
  });

  it("cooperatively aborts an in-flight activation before awaiting its inertia", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let started!: () => void;
    const activationStarted = new Promise<void>((resolve) => { started = resolve; });
    const activation = supervisor.start(entry("abortable"), {
      name: "abortable",
      activate(context) {
        started();
        return new Promise((resolve) => {
          context.signal.addEventListener("abort", () => {
            events.push("aborted");
            resolve(() => { events.push("cleanup"); });
          }, { once: true });
        });
      },
    });
    await activationStarted;
    await Promise.all([activation, supervisor.stop("abortable")]);

    expect(events).toEqual(["aborted", "cleanup"]);
    expect(() => supervisor.status("abortable")).toThrow("Unknown Fabric component");
    await supervisor.close();
    await registry.close();
  });

  it("completes self-retirement requested during activation", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    await supervisor.start(entry("self-removing"), {
      name: "self-removing",
      async activate() {
        await supervisor.stop("self-removing");
        return () => { events.push("cleanup"); };
      },
    });

    expect(events).toEqual(["cleanup"]);
    expect(() => supervisor.status("self-removing")).toThrow("Unknown Fabric component");
    await supervisor.close();
    await registry.close();
  });

  it("does not deadlock on lifecycle calls re-entered from teardown", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    await supervisor.start(entry("self-aware"), {
      name: "self-aware",
      activate() {
        return async () => {
          await supervisor.stop("self-aware");
          try {
            await supervisor.settle();
          } catch (error) {
            events.push(error instanceof Error ? error.message : String(error));
          }
        };
      },
    });

    await supervisor.stop("self-aware");
    expect(events).toEqual([
      "Cannot settle Fabric components from unloading transition self-aware",
    ]);
    await supervisor.close();
    await registry.close();
  });

  it("cannot resurrect a dependent whose provider retires during activation", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activationStarted = new Promise<void>((resolve) => { started = resolve; });
    await supervisor.start(entry("owner"), {
      name: "owner",
      provides: ["svc"],
      activate(context) { context.provide(echoProvider("svc")); },
    });
    const dependentStart = supervisor.start(entry("dependent"), {
      name: "dependent",
      requires: ["svc.echo"],
      async activate() {
        events.push("dependent-start");
        started();
        await gate;
        return () => { events.push("dependent-cleanup"); };
      },
    });
    await activationStarted;
    const ownerStop = supervisor.stop("owner");
    await Promise.resolve();
    release();
    await Promise.all([dependentStart, ownerStop]);
    await supervisor.settle();

    expect(supervisor.status("dependent")).toMatchObject({
      state: "waiting",
      missing: ["svc.echo"],
    });
    expect(events).toEqual(["dependent-start", "dependent-cleanup"]);
    await supervisor.close();
    await registry.close();
  });

  it("owns child fibers as registration effects and unloads them before the parent", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    let childHandle: ReturnType<FabricComponentContext["use"]> | undefined;
    const child: FabricComponentDefinition = {
      name: "child",
      activate() {
        events.push("child-start");
        return async () => {
          await childHandle!.stop();
          events.push("child-cleanup");
        };
      },
    };
    await supervisor.start(entry("parent"), {
      name: "parent",
      activate(context) {
        events.push("parent-start");
        childHandle = context.use(child, { id: "worker" });
        return () => { events.push("parent-cleanup"); };
      },
    });
    await supervisor.settle();

    expect(supervisor.status("parent").state).toBe("active");
    expect(supervisor.status("parent.worker")).toMatchObject({
      parentId: "parent",
      state: "active",
    });
    expect(supervisor.graph().edges).toContainEqual({
      from: "parent.worker",
      to: "parent",
      ref: "component:parent",
      kind: "ownership",
    });
    await supervisor.stop("parent");
    expect(events).toEqual([
      "parent-start",
      "child-start",
      "child-cleanup",
      "parent-cleanup",
    ]);
    expect(() => supervisor.status("parent.worker")).toThrow("Unknown Fabric component");
    await expect(childHandle!.stop()).resolves.toBeUndefined();
    expect(() => childHandle!.status()).toThrow("no longer installed");
    await registry.close();
  });

  it("enforces and reports lifetime effect independence for revertible fibers", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    let disposeFirst!: Awaited<ReturnType<FabricComponentContext["effect"]>>;
    await supervisor.start(entry("first"), {
      name: "first",
      guarantee: "revertible",
      async activate(context) {
        disposeFirst = await context.effect(() => () => {}, {
          label: "first mutation",
          resources: ["workspace:shared"],
          ordering: "ordered",
        });
      },
    });

    await expect(supervisor.start(entry("second"), {
      name: "second",
      guarantee: "revertible",
      async activate(context) {
        await context.effect(() => () => {}, {
          label: "second mutation",
          resources: ["workspace:shared"],
          ordering: "ordered",
        });
      },
    })).rejects.toThrow("non-independent effects");
    expect(supervisor.status("first").effects).toEqual([{
      label: "first mutation",
      kind: "transactional",
      resources: ["workspace:shared"],
      ordering: "ordered",
    }]);
    expect(supervisor.status("second").state).toBe("failed");
    await disposeFirst();
    await supervisor.settle();
    expect(supervisor.status("second").state).toBe("active");
    await supervisor.close();
    await registry.close();
  });

  it("treats an unknown component footprint as top rather than a literal resource", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await supervisor.start(entry("unknown"), {
      name: "unknown",
      async activate(context) {
        await context.effect(() => () => {}, {
          label: "unknown mutation",
          ordering: "ordered",
        });
      },
    });

    await expect(supervisor.start(entry("named"), {
      name: "named",
      guarantee: "revertible",
      async activate(context) {
        await context.effect(() => () => {}, {
          label: "named mutation",
          resources: ["workspace:named"],
          ordering: "ordered",
        });
      },
    })).rejects.toThrow(
      "unknown [*] (unknown resource footprint; declare resources and ordering)",
    );
    await supervisor.close();
    await registry.close();
  });

  it("commits model guidance transactionally and removes it on disposal or rollback", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    let disposeGuidance!: ReturnType<FabricComponentContext["guide"]>;
    let retainedContext!: FabricComponentContext;
    await supervisor.start(entry("guidance"), {
      name: "guidance",
      guarantee: "revertible",
      activate(context) {
        retainedContext = context;
        disposeGuidance = context.guide({
          label: "deepseek-flash",
          models: ["deepseek/deepseek-*"],
          targets: ["main", "participant"],
          content: "Use short tool batches.",
        });
      },
    });

    expect(supervisor.guidance()).toEqual([expect.objectContaining({
      componentId: "guidance",
      label: "deepseek-flash",
      content: "Use short tool batches.",
    })]);
    expect(supervisor.status("guidance")).toMatchObject({
      guidance: [expect.objectContaining({
        label: "deepseek-flash",
        placement: "append",
        contentChars: 23,
      })],
      effects: [expect.objectContaining({
        label: "guidance:deepseek-flash",
        kind: "transactional",
        ordering: "commutative",
      })],
    });

    await disposeGuidance();
    expect(supervisor.guidance()).toEqual([]);
    expect(supervisor.status("guidance").guidance).toBeUndefined();

    const disposeLiveGuidance = retainedContext.guide({
      label: "live-guidance",
      models: ["provider/*"],
      content: "Registered after activation.",
    });
    expect(supervisor.guidance()).toEqual([expect.objectContaining({
      label: "live-guidance",
      content: "Registered after activation.",
    })]);
    await disposeLiveGuidance();
    expect(supervisor.guidance()).toEqual([]);

    await expect(supervisor.start(entry("failed-guidance"), {
      name: "failed-guidance",
      activate(context) {
        context.guide({
          label: "never-committed",
          models: ["provider/*"],
          content: "Do not publish this.",
        });
        throw new Error("activation failed");
      },
    })).rejects.toThrow("activation failed");
    expect(supervisor.guidance()).toEqual([]);
    await supervisor.close();
    await registry.close();
  });

  it("keeps managed conflict evidence informational rather than warning-bearing", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    for (const id of ["first", "second"]) {
      await supervisor.start(entry(id), {
        name: id,
        async activate(context) {
          await context.effect(() => () => {}, { label: `${id} mutation` });
        },
      });
    }
    expect(supervisor.status("first").effects).toHaveLength(1);
    expect(supervisor.status("first").effectConflicts).toBeUndefined();
    expect(supervisor.status("second").effectConflicts).toBeUndefined();
    await supervisor.close();
    await registry.close();
  });

  it("allows witnessed commutative component effects on the same resource", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const definition = (name: string): FabricComponentDefinition => ({
      name,
      guarantee: "revertible",
      async activate(context) {
        await context.effect(() => () => {}, {
          label: `${name} mutation`,
          resources: ["workspace:shared"],
          ordering: "commutative",
        });
      },
    });

    await supervisor.start(entry("first"), definition("first"));
    await supervisor.start(entry("second"), definition("second"));
    expect(supervisor.status("first").effectConflicts).toBeUndefined();
    expect(supervisor.status("second").effectConflicts).toBeUndefined();
    await supervisor.close();
    await registry.close();
  });

  it("tears independent siblings down in reverse activation order", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    const definition = (name: string, revision: string): FabricComponentDefinition => ({
      name,
      activate() { return () => { events.push(`${name}:${revision}`); }; },
    });
    await supervisor.start(entry("first"), definition("first", "old"));
    await supervisor.start(entry("second"), definition("second", "only"));
    await supervisor.replace("first", entry("first"), definition("first", "new"));
    events.length = 0;

    await supervisor.close();
    expect(events).toEqual(["first:new", "second:only"]);
    await registry.close();
  });

  it("quarantines cleanup failures instead of claiming disposal", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await supervisor.start(entry("leaky"), {
      name: "leaky",
      activate() {
        return () => { throw new Error("cleanup leaked"); };
      },
    });

    await expect(supervisor.stop("leaky")).rejects.toThrow("cleanup failed");
    expect(supervisor.status("leaky")).toMatchObject({
      state: "quarantined",
      cleanupErrors: ["component:activate: cleanup leaked"],
    });
    await supervisor.stop("leaky", { force: true });
    expect(() => supervisor.status("leaky")).toThrow("Unknown Fabric component");
    await supervisor.close();
    await registry.close();
  });
});
