import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import { withCodePreviewShell } from "../src/ui/code-preview-shell.js";

describe("code preview startup", () => {
  it("keeps pi-code-previews out of the package and runtime graph", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const indexSource = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    expect(packageJson.dependencies).not.toHaveProperty("pi-code-previews");
    expect(indexSource).not.toMatch(/^import .* from ["']pi-code-previews["'];/m);
    expect(toolSource).not.toContain('from "pi-code-previews"');
    expect(indexSource).not.toContain("pi-code-previews");
  });

  it("uses environment-backed defaults without loading the preview package", () => {
    const previous = process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
    process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = "off";
    try {
      expect(defaultCodePreviewSettings().toolCallBackground).toBe("off");
    } finally {
      if (previous === undefined) delete process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
      else process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = previous;
    }
  });

  it("renders call and result inside a local border shell", () => {
    const tool = {
      name: "sample",
      label: "Sample",
      renderCall: () => ({ render: () => ["call"] }),
      renderResult: () => ({ render: () => ["result"] }),
    } as any;
    const decorated = withCodePreviewShell(tool, {
      mode: "border",
      toolCallTiming: false,
    });
    const state = {};
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const context = {
      state,
      executionStarted: true,
      isPartial: true,
      isError: false,
      invalidate() {},
    } as any;
    const shell = decorated.renderCall({}, { expanded: false, isPartial: true, renderContext: context }, theme);
    decorated.renderResult(
      { content: [] },
      { expanded: false, isPartial: true, renderContext: context },
      theme,
    );
    const rows = shell.render(20);
    expect(decorated.renderShell).toBe("self");
    expect(rows[0]).toBe("╭──────────────────╮");
    expect(rows.some((row: string) => row.includes("call"))).toBe(true);
    expect(rows.some((row: string) => row.includes("result"))).toBe(true);
    expect(rows.at(-1)).toBe("╰──────────────────╯");
  });

  it("preserves shell mode and timing preferences", () => {
    const tool = {
      name: "sample",
      label: "Sample",
      renderCall: () => ({ render: () => ["call"], invalidate() {} }),
      renderResult: () => ({ render: () => ["result"], invalidate() {} }),
    } as any;
    const decorated = withCodePreviewShell(tool, {
      mode: "off",
      toolCallTiming: false,
    });
    expect(decorated.renderShell).toBe("self");
    const context = {
      state: {},
      executionStarted: true,
      isPartial: false,
    } as any;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    decorated.renderCall({}, { expanded: false, isPartial: false, renderContext: context }, theme);
    const result = decorated.renderResult(
      { content: [] },
      { expanded: false, isPartial: false, renderContext: context },
      theme,
    );
    expect(result.render(80)).toEqual(["result"]);
  });
});
