import type { Usage } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricSessionApprovals } from "../src/core/approval-controller.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import {
  FabricDirectToolApproval,
  mergeFabricApprovalUsage,
} from "../src/core/direct-tool-approval.js";

const tool = (name: string, source = "builtin") => ({
  name,
  description: "Run " + name,
  parameters: { type: "object", properties: {} },
  sourceInfo: {
    path: source === "builtin" ? "<builtin:" + name + ">" : "/extensions/example.ts",
    source,
    scope: "temporary" as const,
    origin: "top-level" as const,
  },
});

const event = (toolName: string, input: Record<string, unknown> = {}): ToolCallEvent => ({
  type: "tool_call",
  toolCallId: "call-" + toolName,
  toolName,
  input,
});

const noUiContext = {
  cwd: process.cwd(),
  hasUI: false,
  mode: "print",
} as ExtensionContext;

const usage: Usage = {
  input: 20,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 28,
  cost: {
    input: 0.01,
    output: 0.02,
    cacheRead: 0.001,
    cacheWrite: 0.002,
    total: 0.033,
  },
};

describe("direct OMP tool approvals", () => {
  it("applies configured core and extension risks without wrapping their tools", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.execute = "deny";
    config.approvals.network = "deny";
    config.capture.risks.deploy = "network";
    const approval = new FabricDirectToolApproval(
      { getAllTools: () => [tool("bash"), tool("deploy", "example")] } as never,
      () => config,
      new FabricSessionApprovals(),
    );

    await expect(approval.approve(
      event("bash", { command: "echo safe" }),
      noUiContext,
    )).rejects.toThrow("omp.bash is denied by the Fabric execute policy");
    await expect(approval.approve(
      event("deploy", { target: "production" }),
      noUiContext,
    )).rejects.toThrow("extensions.deploy is denied by the Fabric network policy");
  });

  it("classifies auto calls with the native action and retains classifier usage", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.execute = "auto";
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Bounded command",
      model: "anthropic/classifier",
      usage,
    }));
    const approval = new FabricDirectToolApproval(
      { getAllTools: () => [tool("bash")] } as never,
      () => config,
      new FabricSessionApprovals(),
      { classify } as unknown as FabricAutoApprovalClassifier,
    );
    const call = event("bash", { command: "pnpm test" });

    await approval.approve(call, noUiContext);

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "omp.bash", risk: "execute" }),
      { command: "pnpm test" },
      noUiContext,
      undefined,
    );
    expect(approval.takeUsage(call.toolCallId)).toEqual(usage);
    expect(approval.takeUsage(call.toolCallId)).toBeUndefined();
  });

  it("shares session-wide risk grants across direct calls", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.write = "ask";
    const select = vi.fn(async () => "Allow write access for this session");
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "rpc",
      ui: { select, notify: vi.fn() },
    } as unknown as ExtensionContext;
    const approval = new FabricDirectToolApproval(
      { getAllTools: () => [tool("edit"), tool("write")] } as never,
      () => config,
      new FabricSessionApprovals(),
    );

    await approval.approve(event("edit", { path: "a.ts" }), context);
    await approval.approve(event("write", { path: "b.ts" }), context);

    expect(select).toHaveBeenCalledOnce();
  });

  it("adds classifier usage to existing native tool usage", () => {
    const merged = mergeFabricApprovalUsage({
      ...usage,
      input: 3,
      output: 4,
      totalTokens: 10,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    }, usage);
    expect(merged).toEqual(expect.objectContaining({
      input: 23,
      output: 9,
      cacheRead: 4,
      cacheWrite: 2,
      totalTokens: 38,
      cost: { input: 1.01, output: 2.02, cacheRead: 3.001, cacheWrite: 4.002, total: 10.033 },
    }));
  });
});
