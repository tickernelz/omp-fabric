import { initThemeSync, ToolExecutionComponent, type Theme } from "@oh-my-pi/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

beforeAll(() => {
  initThemeSync(undefined, false, "dark");
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const state = {
  bootstrapped: true,
  initialized: true,
  config: { ui: { showAgentToolPreview: true, toolDisplay: "compact" } },
} as unknown as FabricState;

describe("fabric_exec transcript block", () => {
  it("settles a finished card so the host does not keep it as an active block", () => {
    const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map());
    const card = new ToolExecutionComponent(
      "fabric_exec",
      { code: "return await omp.read({ path: 'src/example.ts' });", display: { name: "Inspect example" } },
      { useBuiltInRenderer: false },
      tool as never,
      { requestRender: () => undefined, requestComponentRender: () => undefined, resetDisplay: () => undefined },
      process.cwd(),
      "call-1",
    );
    card.updateResult(
      {
        content: [{ type: "text", text: "export const example = 1;\n" }],
        details: { audits: [], phases: [] },
        isError: false,
      },
      false,
      "call-1",
    );
    expect(card.isTranscriptBlockFinalized()).toBe(true);
    const lines = card.render(120);
    const text = lines.join("\n");
    expect(text).toContain("export const example = 1;");
    expect(text.split("Inspect example").length - 1).toBe(1);
  });
});
