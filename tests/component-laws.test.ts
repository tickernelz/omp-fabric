import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type {
  FabricComponentDefinition,
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";

const invocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "component-law",
  nestedToolCallId: "component-law",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const service = (value: string): FabricProvider => ({
  name: "svc",
  description: "Law-test service",
  async list() { return [(await this.describe("read", invocationContext()))!]; },
  async describe(name) {
    return name === "read"
      ? {
          name: "read",
          description: "Read the service value",
          inputSchema: { type: "object", additionalProperties: false },
          risk: "read",
        }
      : undefined;
  },
  async invoke() { return value; },
  async close() {},
});

const observableStatus = (supervisor: FabricComponentSupervisor, id: string) => {
  const status = supervisor.status(id);
  return {
    id: status.id,
    component: status.component,
    state: status.state,
    requirements: status.requirements,
    provisions: status.provisions,
    missing: status.missing,
    optionalMissing: status.optionalMissing,
    effects: status.effects,
  };
};

describe("component calculus laws", () => {
  it("commutes whether a dependency or its consumer is inserted first", async () => {
    const run = async (providerFirst: boolean) => {
      const registry = new ActionRegistry();
      const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
      const observations: string[] = [];
      const consumer: FabricComponentDefinition = {
        name: "consumer",
        requires: ["svc.read"],
        async activate(context) {
          observations.push(String(await context.call("svc.read")));
        },
      };
      if (providerFirst) registry.register(service("stable"));
      await supervisor.start({ id: "consumer", component: "consumer" }, consumer);
      if (!providerFirst) registry.register(service("stable"));
      await supervisor.settle();
      const result = {
        status: observableStatus(supervisor, "consumer"),
        observations,
      };
      await supervisor.close();
      await registry.close();
      return result;
    };

    expect(await run(false)).toEqual(await run(true));
  });

  it("recovers the observable provider projection and effects after removal", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const events: string[] = [];
    await supervisor.start({ id: "owner", component: "owner" }, {
      name: "owner",
      provides: ["svc"],
      async activate(context) {
        await context.effect(() => {
          events.push("effect");
          return () => { events.push("inverse"); };
        }, {
          label: "owned mutation",
          resources: ["law:owned"],
          ordering: "ordered",
        });
        context.provide(service("owned"));
      },
    });

    expect(registry.has("svc")).toBe(true);
    expect(supervisor.status("owner").effects).toHaveLength(1);
    await supervisor.stop("owner");
    expect(registry.has("svc")).toBe(false);
    expect(events).toEqual(["effect", "inverse"]);
    await registry.close();
  });

  it("cannot register an orphan child from activation rollback", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    const errors: string[] = [];
    await expect(supervisor.start({ id: "root", component: "root" }, {
      name: "root",
      async *activate(context) {
        yield () => {
          try {
            context.use({ name: "orphan", activate() {} }, { id: "orphan" });
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        };
        throw new Error("activation failed");
      },
    })).rejects.toThrow("activation failed");

    expect(errors).toEqual([
      "Fabric component root can only use children while activating",
    ]);
    expect(supervisor.list().map((component) => component.id)).toEqual(["root"]);
    await supervisor.close();
    await registry.close();
  });

  it("isolates a child failure from its parent and sibling fibers", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await supervisor.start({ id: "parent", component: "parent" }, {
      name: "parent",
      activate(context) {
        context.use({
          name: "broken-child",
          activate() { throw new Error("child failed"); },
        }, { id: "broken" });
        context.use({
          name: "healthy-child",
          activate() {},
        }, { id: "healthy" });
      },
    });
    await supervisor.settle();

    expect(supervisor.status("parent").state).toBe("active");
    expect(supervisor.status("parent.broken")).toMatchObject({
      parentId: "parent",
      state: "failed",
      error: "child failed",
    });
    expect(supervisor.status("parent.healthy")).toMatchObject({
      parentId: "parent",
      state: "active",
    });
    await supervisor.close();
    await registry.close();
  });

  it("refuses to truncate the evidence needed for a revertible guarantee", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    let recovered = 0;
    await expect(supervisor.start({ id: "bounded", component: "bounded" }, {
      name: "bounded",
      guarantee: "revertible",
      activate(context) {
        for (let index = 0; index < 257; index++) {
          context.defer(() => { recovered++; }, {
            label: `effect-${index}`,
            resources: [`resource:${index}`],
            ordering: "ordered",
          });
        }
      },
    })).rejects.toThrow("exceeds 256 tracked effects");
    expect(recovered).toBe(257);
    expect(supervisor.status("bounded").state).toBe("failed");
    await supervisor.close();
    await registry.close();
  });

  it("does not let a revertible fiber relabel an emission as a tracked inverse", async () => {
    const registry = new ActionRegistry();
    const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
    await expect(supervisor.start({ id: "unsafe", component: "unsafe" }, {
      name: "unsafe",
      guarantee: "revertible",
      async activate(context) {
        await context.effect(() => () => {}, {
          kind: "emission",
          label: "outside boundary",
        });
      },
    })).rejects.toThrow("cannot register an emission effect");
    expect(supervisor.status("unsafe").state).toBe("failed");

    let recovered = false;
    await expect(supervisor.start({ id: "deferred", component: "deferred" }, {
      name: "deferred",
      guarantee: "revertible",
      activate(context) {
        context.defer(() => { recovered = true; }, {
          kind: "emission",
          label: "already installed",
        });
      },
    })).rejects.toThrow("cannot defer an emission effect");
    expect(recovered).toBe(true);
    await supervisor.close();
    await registry.close();
  });
});
