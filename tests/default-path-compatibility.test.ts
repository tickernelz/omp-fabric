import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "compatibility",
  nestedToolCallId: "compatibility",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const legacyProvider = (): FabricProvider => ({
  name: "legacy",
  description: "Legacy provider",
  async list() {
    return [
      {
        name: "read",
        description: "Read deterministically",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
        risk: "read",
      },
      {
        name: "write",
        description: "Write deterministically",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        risk: "write",
      },
    ];
  },
  async describe(name) {
    return (await this.list({}, context)).find((action) => action.name === name);
  },
  async invoke(name, args) {
    return name === "read" ? `read:${String(args.key)}` : `write:${String(args.value)}`;
  },
});

describe("ordinary execution compatibility", () => {
  it("keeps uncommitted calls on the established resolve, approve, and result path", async () => {
    const registry = new ActionRegistry();
    registry.register(legacyProvider());
    const approve = vi.fn(async () => {});
    const audits: FabricCallAudit[] = [];

    await expect(registry.invoke("legacy.write", { value: "arc" }, {
      ...context,
      approve,
      audits,
      maxResultChars: 10_000,
    })).resolves.toBe("write:arc");

    expect(approve).toHaveBeenCalledOnce();
    expect(audits).toMatchObject([{
      ref: "legacy.write",
      success: true,
      result: "write:arc",
    }]);
    expect(audits[0]?.effectConflicts).toBeUndefined();
    await registry.close();
  });

  it("pins the model-visible default effects and capability hash format", async () => {
    const registry = new ActionRegistry();
    registry.register(legacyProvider());

    expect(await registry.describe("legacy.read", context)).toMatchObject({
      effect: { kind: "none", ordering: "commutative" },
    });
    expect(await registry.describe("legacy.write", context)).toMatchObject({
      effect: { kind: "emission", ordering: "unknown" },
    });

    const catalog = await registry.catalog(context);
    expect(catalog.root.descriptorHash).toBe(
      "2760c3e07812f5ec22cf165047d8ae50c139612c29e3c1b6a306bd42331261da",
    );
    expect(catalog.providers[0]?.descriptorHash).toBe(
      "ea7af354b287e2b6bc4c7a657c85d730e6c8fe479c426fb1673d48cf0b1d02f7",
    );
    expect(catalog.providers[0]?.actions.map((action) => [action.ref, action.descriptorHash]))
      .toEqual([
        ["legacy.read", "aeb8d5226513b9826c0164a830904c6425b2eef29dc1990b3477d128124fa125"],
        ["legacy.write", "3a3abc74459b4be5902079f9d5f87e74871b112c1b16516b437db3fe345b7e51"],
      ]);
    await registry.close();
  });
});
