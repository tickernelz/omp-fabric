import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import type { FabricTheme } from "../src/ui/render-types.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

beforeAll(() => {
  initTheme({ appearance: "dark" });
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  style: (_tokens: string, text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as FabricTheme;

const state = {
  bootstrapped: true,
  initialized: true,
  config: { ui: { showAgentToolPreview: true, toolDisplay: "compact" } },
} as unknown as FabricState;

describe("fabric_exec transcript block", () => {
  it("renders a settled card once with its result", () => {
    const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map());
    const rendered = tool.renderResult!(
      {
        content: [{ type: "text", text: "export const example = 1;\n" }],
        details: { audits: [], phases: [] },
        isError: false,
      } as never,
      { expanded: false, isPartial: false },
      theme,
      { code: "return await omp.read({ path: 'src/example.ts' });", display: { name: "Inspect example" } } as never,
    );
    const lines = (rendered as { render(width: number): readonly string[] }).render(120);
    const text = lines.join("\n");
    expect(text).toContain("export const example = 1;");
    expect(text.split("Inspect example").length - 1).toBe(1);
  });
});
