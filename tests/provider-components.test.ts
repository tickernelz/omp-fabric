import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentCatalog } from "../src/components/catalog.js";
import { FabricComponentLoader } from "../src/components/loader.js";
import {
  createProviderComponent,
  FABRIC_COMPONENT_PROVIDER_NAMES,
  FabricProviderComponentManifest,
} from "../src/components/provider-component.js";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry, type FabricRegistryInvocationContext } from "../src/core/action-registry.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../src/protocol.js";

const baseContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "provider-component-test",
  nestedToolCallId: "provider-component-test",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const invocation = (): FabricRegistryInvocationContext => ({
  ...baseContext(),
  approve: async () => {},
  audits: [],
  maxResultChars: 10_000,
});

class RevisionProvider implements FabricProvider {
  readonly description = "Stable revision provider";
  readonly #descriptor: FabricActionDescriptor = {
    name: "status",
    description: "Return the active provider revision",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { revision: { type: "string" } },
      required: ["revision"],
      additionalProperties: false,
    },
    risk: "read",
  };

  constructor(
    readonly name: string,
    readonly revision: string,
    readonly onClose: () => void = () => {},
    readonly beforeReturn: () => Promise<void> = async () => {},
  ) {}

  async list(_request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    return [this.#descriptor];
  }

  async describe(name: string): Promise<FabricActionDescriptor | undefined> {
    return name === "status" ? this.#descriptor : undefined;
  }

  async invoke(): Promise<unknown> {
    await this.beforeReturn();
    return { revision: this.revision };
  }

  async close(): Promise<void> {
    this.onClose();
  }
}

const harness = () => {
  const registry = new ActionRegistry();
  const catalog = new FabricComponentCatalog();
  const supervisor = new FabricComponentSupervisor(registry, { invocationContext: baseContext });
  const loader = new FabricComponentLoader(catalog, supervisor);
  return { registry, catalog, supervisor, loader };
};

describe("provider components", () => {
  it("preserves the public catalog when direct registration becomes component ownership", async () => {
    const direct = new ActionRegistry();
    direct.register(new RevisionProvider("memory", "v1"));
    const directCatalog = await direct.catalog(baseContext());

    const { registry, catalog, loader } = harness();
    const component = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("memory", "v1"),
    });
    catalog.register(component.definition);
    await loader.installPinned([component.entry]);

    expect(await registry.catalog(baseContext())).toEqual(directCatalog);
    expect(registry.providers().map(({ name, description }) => ({ name, description }))).toEqual(
      direct.providers().map(({ name, description }) => ({ name, description })),
    );
    expect(await registry.describe("memory.status", baseContext())).toEqual(
      await direct.describe("memory.status", baseContext()),
    );
    expect(await registry.search("revision", baseContext())).toEqual(
      await direct.search("revision", baseContext()),
    );
    expect(await registry.invoke("memory.status", {}, invocation())).toEqual(
      await direct.invoke("memory.status", {}, invocation()),
    );

    await loader.close();
    await registry.close();
    await direct.close();
  });

  it("keeps provider holders independent from unrelated revertible effects", async () => {
    const { registry, catalog, supervisor, loader } = harness();
    let mounted: RevisionProvider | undefined;
    const component = createProviderComponent({
      provider: "mcp",
      description: "MCP provider component",
      create: () => new RevisionProvider("mcp", "v1"),
      mounted: (provider) => { mounted = provider; },
      unmounted: (provider) => {
        if (mounted === provider) mounted = undefined;
      },
    });
    catalog.register(component.definition);
    await loader.installPinned([component.entry]);

    expect(mounted?.revision).toBe("v1");
    expect(supervisor.status("fabric.provider.mcp").effects).toEqual([{
      label: "provider-component:mcp:holder",
      kind: "transactional",
      resources: ["fabric:provider:mcp:holder"],
      ordering: "ordered",
    }]);

    await supervisor.start({ id: "guidance", component: "guidance" }, {
      name: "guidance",
      guarantee: "revertible",
      activate(context) {
        context.guide({
          label: "profile",
          models: ["deepseek/*"],
          content: "Use the DeepSeek profile.",
        });
      },
    });
    expect(supervisor.status("guidance")).toMatchObject({ state: "active" });
    expect(supervisor.status("guidance").effectConflicts).toBeUndefined();

    await loader.close();
    expect(mounted).toBeUndefined();
    await registry.close();
  });

  it("owns every non-kernel first-party namespace through a pinned component", async () => {
    const { registry, catalog, loader } = harness();
    const direct = new ActionRegistry();
    const manifest = new FabricProviderComponentManifest(catalog, loader);
    for (const name of FABRIC_COMPONENT_PROVIDER_NAMES) {
      direct.register(new RevisionProvider(name, "v1"));
      await manifest.install(createProviderComponent({
        provider: name,
        description: `${name} provider component`,
        create: () => new RevisionProvider(name, "v1"),
      }));
    }
    manifest.assertActive(FABRIC_COMPONENT_PROVIDER_NAMES, registry);
    expect(manifest.entries()).toEqual(loader.pinnedEntries());

    expect(registry.providers().map((provider) => provider.name).sort()).toEqual(
      [...FABRIC_COMPONENT_PROVIDER_NAMES].sort(),
    );
    expect(await registry.catalog(baseContext())).toEqual(await direct.catalog(baseContext()));
    for (const name of FABRIC_COMPONENT_PROVIDER_NAMES) {
      expect(loader.status(`fabric.provider.${name}`)).toMatchObject({
        state: "active",
        provisions: [name],
      });
      await expect(registry.invoke(`${name}.status`, {}, invocation())).resolves.toEqual({
        revision: "v1",
      });
    }

    await loader.close();
    await registry.close();
    await direct.close();
  });

  it("fails startup completeness when an enabled namespace lacks a pinned binding", async () => {
    const { registry, catalog, loader } = harness();
    const manifest = new FabricProviderComponentManifest(catalog, loader);
    await manifest.install(createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("memory", "v1"),
    }));

    expect(() => manifest.assertActive(["memory", "mcp"], registry)).toThrow(
      "Missing: mcp",
    );
    expect(() => manifest.assertActive([], registry)).toThrow(
      "Unexpected: memory",
    );

    await loader.close();
    await registry.close();
  });

  it("rolls a provider definition while committed calls retain the old generation", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    const v1 = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("memory", "v1", () => events.push("v1-close")),
    });
    catalog.register(v1.definition);
    await loader.installPinned([v1.entry]);
    const lease = await registry.acquireCapabilityView(["memory.status"], baseContext());
    expect(lease.satisfied).toBe(true);
    const committedView = lease.view;
    if (!committedView) throw new Error("Expected a committed memory view");

    const v2 = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("memory", "v2", () => events.push("v2-close")),
    });
    catalog.register(v2.definition, { overwrite: true });
    await loader.settle();

    await expect(registry.invoke("memory.status", {}, invocation())).resolves.toEqual({
      revision: "v2",
    });
    await expect(registry.invoke("memory.status", {}, {
      ...invocation(),
      capabilityView: committedView,
    })).resolves.toEqual({ revision: "v1" });
    expect(events).toEqual([]);

    await lease.release();
    expect(events).toEqual(["v1-close"]);
    await loader.close();
    expect(events).toEqual(["v1-close", "v2-close"]);
    await registry.close();
  });

  it("keeps an in-flight old generation alive after a component roll commits", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    let releaseCall!: () => void;
    let markStarted!: () => void;
    const callGate = new Promise<void>((resolve) => { releaseCall = resolve; });
    const callStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const v1 = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider(
        "memory",
        "v1",
        () => events.push("v1-close"),
        async () => {
          markStarted();
          await callGate;
        },
      ),
    });
    catalog.register(v1.definition);
    await loader.installPinned([v1.entry]);

    const call = registry.invoke("memory.status", {}, invocation());
    await callStarted;
    const v2 = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("memory", "v2"),
    });
    catalog.register(v2.definition, { overwrite: true });
    await loader.settle();

    expect(events).toEqual([]);
    await expect(registry.invoke("memory.status", {}, invocation())).resolves.toEqual({
      revision: "v2",
    });
    releaseCall();
    await expect(call).resolves.toEqual({ revision: "v1" });
    expect(events).toEqual(["v1-close"]);

    await loader.close();
    await registry.close();
  });

  it("withdraws a provider committed during synchronous self-retirement", async () => {
    const { registry, supervisor } = harness();
    const events: string[] = [];
    const component = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider(
        "memory",
        "diverted",
        () => events.push("provider-close"),
      ),
    });
    let stopRequest: Promise<void> | undefined;
    let unsubscribe = () => {};
    unsubscribe = registry.subscribeProviderChanges((event) => {
      if (event.type !== "activated" || event.binding.name !== "memory") return;
      unsubscribe();
      stopRequest = supervisor.stop(component.entry.id);
    });

    const result = await supervisor.start(component.entry, component.definition);
    await stopRequest;

    expect(result.state).toBe("disposed");
    expect(() => supervisor.status(component.entry.id)).toThrow("Unknown Fabric component");
    expect(registry.has("memory")).toBe(false);
    expect(events).toEqual(["provider-close"]);

    await supervisor.close();
    await registry.close();
  });

  it("reloads a committed dependent onto the replacement provider generation", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    const v1 = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider(
        "memory",
        "v1",
        () => events.push("provider-v1-close"),
      ),
    });
    catalog.register(v1.definition);
    await loader.installPinned([v1.entry]);
    catalog.register({
      name: "memory-consumer",
      requires: ["memory.status"],
      async activate(context) {
        const result = await context.call("memory.status") as { revision: string };
        events.push(`consumer-${result.revision}-start`);
        return () => { events.push(`consumer-${result.revision}-stop`); };
      },
    });
    await loader.reconcile([{ id: "memory-consumer", component: "memory-consumer" }]);

    const v2 = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("memory", "v2"),
    });
    catalog.register(v2.definition, { overwrite: true });
    await loader.settle();

    expect(loader.status("memory-consumer")).toMatchObject({ state: "active" });
    expect(events).toEqual([
      "consumer-v1-start",
      "consumer-v1-stop",
      "provider-v1-close",
      "consumer-v2-start",
    ]);
    await expect(registry.invoke("memory.status", {}, invocation())).resolves.toEqual({
      revision: "v2",
    });

    await loader.close();
    await registry.close();
  });

  it("restores the prior provider namespace after a candidate activation fails", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    const stable = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider(
        "memory",
        "v1",
        () => events.push("v1-close"),
      ),
    });
    catalog.register(stable.definition);
    await loader.installPinned([stable.entry]);
    const before = await registry.describe("memory.status", baseContext());

    const broken = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider(
        "memory",
        "broken",
        () => events.push("broken-close"),
      ),
      start: () => { throw new Error("candidate activation failed"); },
    });
    catalog.register(broken.definition, { overwrite: true });
    await loader.settle();

    expect(loader.status("fabric.provider.memory")).toMatchObject({
      state: "active",
      revision: 3,
      error: expect.stringContaining("previous revision restored"),
    });
    expect(registry.has("memory")).toBe(true);
    expect(await registry.describe("memory.status", baseContext())).toEqual(before);
    await expect(registry.invoke("memory.status", {}, invocation())).resolves.toEqual({
      revision: "v1",
    });
    expect(events).toEqual(["v1-close", "broken-close"]);

    await loader.close();
    expect(events).toEqual(["v1-close", "broken-close", "v1-close"]);
    await registry.close();
  });

  it("closes a provider whose factory returns the wrong namespace", async () => {
    const { registry, catalog, loader } = harness();
    const events: string[] = [];
    const component = createProviderComponent({
      provider: "memory",
      description: "Memory provider component",
      create: () => new RevisionProvider("wrong", "v1", () => events.push("closed")),
    });
    const manifest = new FabricProviderComponentManifest(catalog, loader);

    await expect(manifest.install(component)).rejects.toThrow(
      "created wrong, expected memory",
    );
    expect(events).toEqual(["closed"]);
    expect(manifest.entries()).toEqual([]);
    expect(catalog.get("fabric.provider.memory")).toBeUndefined();
    await loader.close();
    await registry.close();
  });
});
