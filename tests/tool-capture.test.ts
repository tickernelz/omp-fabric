import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionRunner, RegisteredTool } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@oh-my-pi/omptype/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import {
  bundleExtensionRunnerConstructors,
  installRegisteredToolCapture,
  type RegisteredToolCaptureController,
} from "../src/capture/interceptor.js";
import { DEFAULT_FABRIC_CONFIG, effectiveToolCaptureConfig } from "../src/config.js";

const controllers: RegisteredToolCaptureController[] = [];
const capturePolicy = { ...DEFAULT_FABRIC_CONFIG.capture, enabled: true };

const tool = (name: string) => ({
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    execute: vi.fn(async (_id: string, params: { value?: string }) => ({
      content: [{ type: "text" as const, text: params.value ?? name }],
      details: {},
    })),
  });

const registered = (definition: ReturnType<typeof tool>, sourcePath: string): RegisteredTool => ({
  definition,
  extensionPath: sourcePath,
});

const runnerWith = (...entries: RegisteredTool[]): ExtensionRunner => {
  const extensions = [{ tools: new Map(entries.map((entry) => [entry.definition.name, entry])) }];
  const runner = {
    extensions,
    getAllRegisteredTools: () => [...extensions[0]!.tools.values()],
  };
  return runner as unknown as ExtensionRunner;
};

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("registered extension tool capture", () => {
  it("captures every extension tool while keeping it in OMP's registry", async () => {
    // Captured tools must stay visible to omp.getAllTools() consumers (e.g.
    // permission systems validating tool_call events); hiding from the model is
    // handled through the active tool set by FabricToolOwnership, not here.
    const fabricTool = tool("fabric_exec");
    const customTool = tool("deploy_release");
    const readOverride = tool("read");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/omp-fabric/index.ts"),
      registered(customTool, "/extensions/pi-deploy/index.ts"),
      registered(readOverride, "/extensions/pi-preview/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      runner,
      initialPolicy: capturePolicy,
    });
    controllers.push(controller);

    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "deploy_release",
      "read",
    ]);
    expect(catalog.list().map((entry) => entry.name)).toEqual(["deploy_release", "read"]);
    expect(catalog.require("deploy_release").risk).toBe("execute");
    expect(catalog.require("read").risk).toBe("read");

    controller.dispose();
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "deploy_release",
      "read",
    ]);
    expect(catalog.size).toBe(0);
  });

  it("refresh() repopulates after a suspended-pass clear, as on /reload (#73)", async () => {
    const fabricTool = tool("fabric_exec");
    const customTool = tool("deploy_release");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/omp-fabric/index.ts"),
      registered(customTool, "/extensions/pi-deploy/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      runner,
      initialPolicy: capturePolicy,
    });
    controllers.push(controller);

    runner.getAllRegisteredTools();
    expect(catalog.get("deploy_release")).toBeDefined();

    // session_start suspends capture, then /reload re-registers extensions and
    // refreshes the tool registry while suspension is still active: the hub
    // listener runs with enabled:false and clears the catalog.
    controller.setPolicy({ ...structuredClone(DEFAULT_FABRIC_CONFIG.capture), enabled: false });
    runner.getAllRegisteredTools();
    expect(catalog.get("deploy_release")).toBeUndefined();

    // session_start re-enables capture, but setPolicy(enabled) fires nothing —
    // the catalog would stay empty until restart without a forced refresh.
    controller.setPolicy(capturePolicy);
    expect(catalog.get("deploy_release")).toBeUndefined();

    catalog.refresh();
    expect(catalog.get("deploy_release")).toBeDefined();
    expect(catalog.get("fabric_exec")).toBeUndefined();
  });

  it("classifies Fovea's graph-navigation tools as read-only", () => {
    const definitions = [
      "fovea_sketch",
      "fovea_focus",
      "fovea_dwell",
      "fovea_impact",
    ].map((name) => tool(name));
    const entries = definitions.map((definition) =>
      registered(definition, "/extensions/pi-fovea/src/index.ts"),
    );
    const runner = runnerWith(...entries);
    const catalog = new CapturedToolCatalog();

    catalog.replace(
      entries,
      runner,
      capturePolicy,
      "/extensions/omp-fabric/index.ts",
    );

    expect(
      Object.fromEntries(catalog.list().map((entry) => [entry.name, entry.risk])),
    ).toEqual({
      fovea_dwell: "read",
      fovea_focus: "read",
      fovea_impact: "read",
      fovea_sketch: "read",
    });
  });

  it("does not attach to an unrelated tool with the Fabric tool name", async () => {
    const fabricTool = tool("fabric_exec");
    const collidingTool = tool("fabric_exec");
    const customTool = tool("custom_tool");
    const runner = runnerWith(
      registered(collidingTool, "/extensions/collision/index.ts"),
      registered(customTool, "/extensions/custom/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      runner,
      initialPolicy: capturePolicy,
    });
    controllers.push(controller);

    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "custom_tool",
    ]);
    expect(catalog.size).toBe(0);
  });

  it("updates dynamically and clears the catalog when capture disables", async () => {
    const fabricTool = tool("fabric_exec");
    const first = registered(tool("first_tool"), "/extensions/one/index.ts");
    const runner = runnerWith(registered(fabricTool, "/extensions/omp-fabric/index.ts"), first);
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      runner,
      initialPolicy: capturePolicy,
    });
    controllers.push(controller);

    runner.getAllRegisteredTools();
    const extension = (
      runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> }
    ).extensions[0];
    const second = registered(tool("second_tool"), "/extensions/two/index.ts");
    extension?.tools.set(second.definition.name, second);
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "first_tool",
      "second_tool",
    ]);
    expect(catalog.list().map((entry) => entry.name)).toEqual(["first_tool", "second_tool"]);

    controller.setPolicy(
      effectiveToolCaptureConfig({
        fullCodeMode: false,
        capture: DEFAULT_FABRIC_CONFIG.capture,
      }),
    );
    expect(catalog.size).toBe(0);
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "first_tool",
      "second_tool",
    ]);
  });

  it("notifies on every catalog refresh so ownership can be re-asserted", async () => {
    const fabricTool = tool("fabric_exec");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/omp-fabric/index.ts"),
      registered(tool("deploy_release"), "/extensions/pi-deploy/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    let refreshes = 0;
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      onCatalogRefresh: () => {
        refreshes += 1;
      },
      runner,
      initialPolicy: capturePolicy,
    });
    controllers.push(controller);

    expect(refreshes).toBe(0);
    runner.getAllRegisteredTools();
    expect(refreshes).toBe(1);
    runner.getAllRegisteredTools();
    expect(refreshes).toBe(2);

    controller.dispose();
    runner.getAllRegisteredTools();
    expect(refreshes).toBe(2);
  });

  it("discovers the bundled runtime's distinct ExtensionRunner identity (pi >= 0.84.3)", async () => {
    // The pi >= 0.84.3 CLI runs from dist/bundle chunks with their own
    // ExtensionRunner class identity; capture must patch that copy or the live
    // host runner's registrations are never observed.
    const bundleDir = await mkdtemp(path.join(tmpdir(), "fabric-bundle-"));
    try {
      const chunksDir = path.join(bundleDir, "chunks");
      await mkdir(chunksDir, { recursive: true });
      await writeFile(
        path.join(chunksDir, "chunk-fake.js"),
        "export class ExtensionRunner { getAllRegisteredTools() { return []; } }\n",
      );
      await writeFile(path.join(chunksDir, "stats.json"), "{}");
      const found = await bundleExtensionRunnerConstructors(bundleDir);
      expect(found).toHaveLength(1);
      const discovered = found[0]!;
      expect(discovered).toBeDefined();
      expect(typeof discovered.prototype.getAllRegisteredTools).toBe("function");
      // Modular-layout installs (no dist/bundle) yield nothing.
      const plainDir = await mkdtemp(path.join(tmpdir(), "fabric-nobundle-"));
      try {
        expect(await bundleExtensionRunnerConstructors(plainDir)).toEqual([]);
      } finally {
        await rm(plainDir, { recursive: true, force: true });
      }
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });
});
