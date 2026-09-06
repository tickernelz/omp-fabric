import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentCatalog } from "../src/components/catalog.js";
import { FabricComponentLoader } from "../src/components/loader.js";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const invocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "loader-test",
  nestedToolCallId: "loader-test",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const harness = () => {
  const registry = new ActionRegistry();
  const catalog = new FabricComponentCatalog();
  const supervisor = new FabricComponentSupervisor(registry, { invocationContext });
  const loader = new FabricComponentLoader(catalog, supervisor);
  return { registry, catalog, supervisor, loader };
};

describe("FabricComponentLoader", () => {
  it("keeps unknown configured definitions waiting, then activates on discovery", async () => {
    const { registry, catalog, loader } = harness();
    await loader.reconcile([{ id: "late", component: "late-definition" }]);
    expect(loader.status("late")).toMatchObject({
      state: "waiting",
      missing: ["component:late-definition"],
    });

    catalog.register({
      name: "late-definition",
      activate() {},
    });
    await loader.settle();
    expect(loader.status("late")).toMatchObject({ state: "active", revision: 1 });

    await loader.close();
    await registry.close();
  });

  it("keeps pinned built-ins across config reconciliation and rolls their definitions", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    catalog.register({
      name: "fabric.provider.memory",
      activate() {
        events.push("v1-start");
        return () => { events.push("v1-stop"); };
      },
    });

    await loader.installPinned([{
      id: "fabric.provider.memory",
      component: "fabric.provider.memory",
    }]);
    await loader.reconcile([]);
    expect(loader.pinnedEntries()).toEqual([{
      id: "fabric.provider.memory",
      component: "fabric.provider.memory",
    }]);
    expect(loader.status("fabric.provider.memory")).toMatchObject({
      state: "active",
      revision: 1,
    });

    catalog.register({
      name: "fabric.provider.memory",
      activate() {
        events.push("v2-start");
        return () => { events.push("v2-stop"); };
      },
    }, { overwrite: true });
    await loader.settle();
    expect(loader.status("fabric.provider.memory")).toMatchObject({
      state: "active",
      revision: 2,
    });
    expect(events).toEqual(["v1-start", "v1-stop", "v2-start"]);

    await expect(loader.reconcile([{
      id: "fabric.provider.memory",
      component: "user-memory",
    }])).rejects.toThrow("reserved by a pinned component");

    await loader.close();
    expect(events).toEqual(["v1-start", "v1-stop", "v2-start", "v2-stop"]);
    await registry.close();
  });

  it("serializes pinned and configured ID collision checks", async () => {
    const { registry, catalog, loader } = harness();
    catalog.register({ name: "fabric.provider.memory", activate() {} });
    catalog.register({ name: "user-memory", activate() {} });

    const installing = loader.installPinned([{
      id: "fabric.provider.memory",
      component: "fabric.provider.memory",
    }]);
    const reconciling = loader.reconcile([{
      id: "fabric.provider.memory",
      component: "user-memory",
    }]);

    await installing;
    await expect(reconciling).rejects.toThrow("reserved by a pinned component");
    expect(loader.status("fabric.provider.memory")).toMatchObject({
      component: "fabric.provider.memory",
      state: "active",
    });

    await loader.close();
    await registry.close();
  });

  it("rolls back a failed catalog replacement and applies the next valid revision", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    catalog.register({
      name: "hot",
      activate() {
        events.push("v1-start");
        return () => { events.push("v1-stop"); };
      },
    });
    await loader.reconcile([{ id: "hot", component: "hot" }]);

    catalog.register({
      name: "hot",
      activate() {
        events.push("broken-start");
        throw new Error("hot replacement failed");
      },
    }, { overwrite: true });
    await loader.settle();
    expect(loader.status("hot")).toMatchObject({
      state: "active",
      error: expect.stringContaining("previous revision restored"),
    });

    catalog.register({
      name: "hot",
      activate() {
        events.push("v3-start");
        return () => { events.push("v3-stop"); };
      },
    }, { overwrite: true });
    await loader.settle();
    expect(loader.status("hot")).toMatchObject({ state: "active" });
    expect(loader.status("hot").error).toBeUndefined();
    expect(events).toEqual([
      "v1-start",
      "v1-stop",
      "broken-start",
      "v1-start",
      "v1-stop",
      "v3-start",
    ]);

    await loader.close();
    await registry.close();
  });

  it("rejects loader re-entry from teardown instead of deadlocking its queue", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    catalog.register({
      name: "reentrant",
      activate() {
        return async () => {
          try {
            await loader.reload();
          } catch (error) {
            events.push(error instanceof Error ? error.message : String(error));
          }
        };
      },
    });
    await loader.reconcile([{ id: "reentrant", component: "reentrant" }]);
    await loader.reconcile([]);

    expect(events).toEqual([
      "Cannot reload the component loader from unloading transition reentrant",
    ]);
    expect(loader.list()).toEqual([]);
    await loader.close();
    await registry.close();
  });

  it("rolls back earlier additions when a graph reconciliation fails", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    catalog.register({
      name: "good",
      activate() {
        events.push("good-start");
        return () => { events.push("good-stop"); };
      },
    });
    catalog.register({
      name: "bad",
      activate() {
        throw new Error("bad activation");
      },
    });

    await expect(loader.reconcile([
      { id: "good", component: "good" },
      { id: "bad", component: "bad" },
    ])).rejects.toThrow("bad activation");
    expect(loader.list()).toEqual([]);
    expect(loader.entries()).toEqual([]);
    expect(events).toEqual(["good-start", "good-stop"]);

    await loader.close();
    await registry.close();
  });
});
