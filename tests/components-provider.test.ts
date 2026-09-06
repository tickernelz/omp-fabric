import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentCatalog } from "../src/components/catalog.js";
import { FabricComponentLoader } from "../src/components/loader.js";
import { createProviderComponent } from "../src/components/provider-component.js";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { ComponentsProvider } from "../src/providers/components-provider.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "components-provider-test",
  nestedToolCallId: "components-provider-test",
  extensionContext: {} as ExtensionContext,
  update() {},
};

describe("ComponentsProvider", () => {
  it("reloads a pinned provider component through the stable components API", async () => {
    const registry = new ActionRegistry();
    const catalog = new FabricComponentCatalog();
    const supervisor = new FabricComponentSupervisor(registry, {
      invocationContext: () => context,
    });
    const loader = new FabricComponentLoader(catalog, supervisor);
    const provider = new ComponentsProvider(loader);
    catalog.register({ name: "fabric.provider.memory", activate() {} });
    await loader.installPinned([{
      id: "fabric.provider.memory",
      component: "fabric.provider.memory",
    }]);

    expect(await provider.invoke("reload", { id: "fabric.provider.memory" }, context)).toMatchObject({
      components: [expect.objectContaining({
        id: "fabric.provider.memory",
        state: "active",
        revision: 2,
      })],
    });

    await loader.close();
    await registry.close();
  });

  it("reports a failed provider reload after restoring its namespace", async () => {
    const registry = new ActionRegistry();
    const catalog = new FabricComponentCatalog();
    const supervisor = new FabricComponentSupervisor(registry, {
      invocationContext: () => context,
    });
    const loader = new FabricComponentLoader(catalog, supervisor);
    const provider = new ComponentsProvider(loader);
    let activations = 0;
    let closes = 0;
    const component = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => {
        activations++;
        return {
          name: "memory",
          description: "Memory provider",
          async list() {
            return [{
              name: "status",
              description: "Read status",
              inputSchema: { type: "object", additionalProperties: false },
              risk: "read",
            }];
          },
          async describe() {
            return (await this.list({}, context))[0];
          },
          async invoke() { return { available: true }; },
          async close() { closes++; },
        } as FabricProvider;
      },
      start: () => {
        if (activations === 2) throw new Error("reload candidate failed");
      },
    });
    catalog.register(component.definition);
    await loader.installPinned([component.entry]);

    await expect(provider.invoke(
      "reload",
      { id: "fabric.provider.memory" },
      context,
    )).rejects.toThrow("previous revision restored");

    expect(loader.status("fabric.provider.memory")).toMatchObject({
      state: "active",
      revision: 3,
      error: expect.stringContaining("previous revision restored"),
    });
    expect(registry.has("memory")).toBe(true);
    await expect(registry.invoke("memory.status", {}, {
      ...context,
      approve: async () => {},
      audits: [],
      maxResultChars: 2_000,
    })).resolves.toEqual({ available: true });
    expect(closes).toBe(2);

    await expect(provider.invoke(
      "reload",
      { id: "fabric.provider.memory" },
      context,
    )).resolves.toMatchObject({
      components: [expect.objectContaining({ revision: 4, state: "active" })],
    });
    expect(loader.status("fabric.provider.memory").error).toBeUndefined();
    expect(closes).toBe(3);

    await loader.close();
    expect(closes).toBe(4);
    await registry.close();
  });

  it("exposes list, status, graph, and rollback-capable reload actions", async () => {
    const registry = new ActionRegistry();
    const catalog = new FabricComponentCatalog();
    const supervisor = new FabricComponentSupervisor(registry, {
      invocationContext: () => context,
    });
    const loader = new FabricComponentLoader(catalog, supervisor);
    const provider = new ComponentsProvider(loader);
    catalog.register({ name: "service", activate() {} });
    await loader.reconcile([{ id: "service", component: "service" }]);

    expect((await provider.list({}, context)).map((action) => action.name)).toEqual([
      "list",
      "status",
      "graph",
      "reload",
    ]);
    expect(await provider.invoke("status", { id: "service" }, context)).toMatchObject({
      id: "service",
      state: "active",
      revision: 1,
    });
    expect(await provider.invoke("graph", {}, context)).toMatchObject({
      components: [expect.objectContaining({ id: "service" })],
      edges: [],
      cycles: [],
    });
    expect(await provider.invoke("reload", { id: "service" }, context)).toMatchObject({
      components: [expect.objectContaining({ id: "service", revision: 2 })],
    });
    expect(await provider.invoke("list", {}, context)).toMatchObject({
      definitions: [expect.objectContaining({ name: "service", revision: 1 })],
      components: [expect.objectContaining({ id: "service", state: "active" })],
    });

    await loader.close();
    await registry.close();
  });
});
