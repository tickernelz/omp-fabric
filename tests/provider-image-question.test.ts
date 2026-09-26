import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricInvocationContext } from "../src/protocol.js";
import { OmpToolsProvider } from "../src/providers/omp-tools-provider.js";

const roots: string[] = [];

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fabric-image-q-"));
  roots.push(dir);
  return dir;
};

const context = (cwd: string): FabricInvocationContext =>
  ({
    cwd,
    signal: undefined,
    parentToolCallId: "parent",
    nestedToolCallId: "nested",
    extensionContext: {} as never,
    update() {},
  }) as unknown as FabricInvocationContext;

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const emptyRegistry = {
  getAvailable: () => [],
  getApiKey: async () => undefined,
} as unknown as NonNullable<ToolSession["modelRegistry"]>;

const textOnlyRegistry = (model: { provider: string; id: string; input: string[] }) =>
  ({
    getAvailable: () => [model],
    getApiKey: async () => undefined,
  }) as unknown as NonNullable<ToolSession["modelRegistry"]>;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("omp.read image questions", () => {
  it("carries the host model registry into the session the read tool runs on", async () => {
    const cwd = scratch();
    const provider = await OmpToolsProvider.create(
      cwd,
      undefined,
      undefined,
      undefined,
      {
        getSessionId: () => "image-question-session",
        modelRegistry: emptyRegistry,
        getActiveModelString: () => "modelrouter/deepseek-v4.1-flash",
      },
    );

    const file = path.join(cwd, "shot.png");
    fs.writeFileSync(file, TINY_PNG);

    const failure = await provider
      .invoke("read", { path: file + "?q=what is on screen" }, context(cwd))
      .then(
        () => undefined,
        (error: unknown) => String(error),
      );

    expect(failure).toBe("ToolError: No models available for image questions.");
  });

  it("offers the session's active model as the image-question fallback", async () => {
    const cwd = scratch();
    const model = { provider: "modelrouter", id: "deepseek-v4.1-flash", input: ["text"] };
    const provider = await OmpToolsProvider.create(
      cwd,
      undefined,
      undefined,
      undefined,
      {
        getSessionId: () => "image-question-model-session",
        modelRegistry: textOnlyRegistry(model),
        getActiveModelString: () => `${model.provider}/${model.id}`,
      },
    );

    const file = path.join(cwd, "shot.png");
    fs.writeFileSync(file, TINY_PNG);

    const failure = await provider
      .invoke("read", { path: file + "?q=what is on screen" }, context(cwd))
      .then(
        () => undefined,
        (error: unknown) => String(error),
      );

    expect(failure).toBe(
      `ToolError: Resolved model ${model.provider}/${model.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
    );
  });

  it("cannot pick a model at all when the session reports no active model", async () => {
    const cwd = scratch();
    const model = { provider: "modelrouter", id: "deepseek-v4.1-flash", input: ["text"] };
    const provider = await OmpToolsProvider.create(
      cwd,
      undefined,
      undefined,
      undefined,
      {
        getSessionId: () => "image-question-no-model-session",
        modelRegistry: textOnlyRegistry(model),
      },
    );

    const file = path.join(cwd, "shot.png");
    fs.writeFileSync(file, TINY_PNG);

    const failure = await provider
      .invoke("read", { path: file + "?q=what is on screen" }, context(cwd))
      .then(
        () => undefined,
        (error: unknown) => String(error),
      );

    expect(failure).toBe("ToolError: Unable to resolve a model for image questions.");
  });

  it("reports the missing registry rather than silently dropping the question", async () => {
    const cwd = scratch();
    const provider = await OmpToolsProvider.create(cwd);

    const file = path.join(cwd, "shot.png");
    fs.writeFileSync(file, TINY_PNG);

    const failure = await provider
      .invoke("read", { path: file + "?q=what is on screen" }, context(cwd))
      .then(
        () => undefined,
        (error: unknown) => String(error),
      );

    expect(failure).toContain("Model registry is unavailable for image questions.");
  });
});
