import { describe, expect, it } from "vitest";
import {
  entropySurfaceHash,
  liveSurfaceSnapshot,
  surfaceFreedomReport,
  type EntropySurfaceRegistry,
} from "../src/entropy/index.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const schemaOf = (kind: "free" | "enum" | "const"): unknown =>
  kind === "free"
    ? {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      }
    : kind === "enum"
      ? {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: { mode: { type: "string", enum: ["fast", "slow"] } },
        }
      : {
          type: "object",
          additionalProperties: false,
          required: ["flag"],
          properties: { flag: { const: true } },
        };

const registryWith = (
  actions: Array<{ ref: string; inputSchema: unknown }>,
): {
  registry: EntropySurfaceRegistry;
  context: () => FabricInvocationContext | undefined;
  request: () => { limit?: number; declared?: boolean } | undefined;
} => {
  let seen: FabricInvocationContext | undefined;
  let lastRequest: { limit?: number; declared?: boolean } | undefined;
  const registry: EntropySurfaceRegistry = {
    list: async (request, context) => {
      seen = context;
      lastRequest = request;
      return actions;
    },
  };
  return { registry, context: () => seen, request: () => lastRequest };
};

const extensionContext = {} as ExtensionContext;

describe("liveSurfaceSnapshot", () => {
  it("lists through the discovery path with a synthetic context, sorted by ref", async () => {
    const { registry, context, request } = registryWith([
      { ref: "memory.expand", inputSchema: schemaOf("free") },
      { ref: "mcp.report.render", inputSchema: schemaOf("enum") },
    ]);
    const snapshot = await liveSurfaceSnapshot({
      registry,
      extensionContext,
      cwd: "/repo",
    });
    expect(snapshot.version).toBe(1);
    expect(snapshot.actions.map((action) => action.ref)).toEqual([
      "mcp.report.render",
      "memory.expand",
    ]);
    expect(request()).toEqual({ limit: 1000, declared: true });
    expect(context()?.cwd).toBe("/repo");
    expect(context()?.parentToolCallId).toBe("fabric-entropy-surface");
    expect(typeof context()?.update).toBe("function");
  });

  it("hashes stably across repeated snapshots", async () => {
    const { registry } = registryWith([
      {
        ref: "memory.expand",
        inputSchema: {
          type: "object",
          properties: { b: { type: "string" }, a: { type: "number" } },
        },
      },
    ]);
    const first = await liveSurfaceSnapshot({ registry, extensionContext, cwd: "/repo" });
    const second = await liveSurfaceSnapshot({ registry, extensionContext, cwd: "/repo" });
    expect(entropySurfaceHash(first)).toBe(entropySurfaceHash(second));
  });
});

describe("surfaceFreedomReport", () => {
  it("scores and sorts the surface worst-first", () => {
    const report = surfaceFreedomReport({
      version: 1,
      actions: [
        { ref: "memory.expand", inputSchema: schemaOf("free") },
        { ref: "mcp.report.render", inputSchema: schemaOf("enum") },
        { ref: "state.get", inputSchema: schemaOf("const") },
      ],
    });
    expect(report.actions.map((action) => action.ref)).toEqual([
      "memory.expand",
      "mcp.report.render",
      "state.get",
    ]);
    expect(report.actions[0]?.freedom).toBe(1);
    expect(report.actions[1]?.freedom).toBe(0.166667);
    expect(report.actions[2]?.freedom).toBe(0);
    expect(report.total).toBe(1.166667);
    expect(report.mean).toBe(0.388889);
  });

  it("handles an empty surface", () => {
    const report = surfaceFreedomReport({ version: 1, actions: [] });
    expect(report.total).toBe(0);
    expect(report.mean).toBe(0);
    expect(report.actions).toEqual([]);
  });
});
