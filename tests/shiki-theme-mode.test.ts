import { describe, expect, it } from "vitest";
import {
  defaultCodePreviewSettings,
  normalizeCodePreviewSettings,
  parseShikiThemePreference,
  resolveShikiTheme,
} from "../src/ui/code-preview.js";
import {
  classifyOmpTheme,
  configureHighlighting,
  effectiveShikiTheme,
  effectiveShikiThemeIsLight,
  observeOmpTheme,
  observedThemeVariant,
} from "../src/ui/highlight.js";
import { createDiffBackgroundResolver } from "../src/ui/diff-background.js";
import { normalizeFabricConfig } from "../src/config.js";

describe("shiki theme preference parsing", () => {
  it("treats auto as the built-in light/dark pair", () => {
    expect(parseShikiThemePreference("auto")).toEqual({
      lightTheme: "github-light",
      darkTheme: "dark-plus",
      followsVariant: true,
    });
    expect(parseShikiThemePreference("  ")).toEqual({
      lightTheme: "github-light",
      darkTheme: "dark-plus",
      followsVariant: true,
    });
  });

  it("parses explicit light/dark pairs", () => {
    expect(parseShikiThemePreference("solarized-light/solarized-dark")).toEqual({
      lightTheme: "solarized-light",
      darkTheme: "solarized-dark",
      followsVariant: true,
    });
    expect(resolveShikiTheme("solarized-light/solarized-dark", "light")).toBe("solarized-light");
    expect(resolveShikiTheme("solarized-light/solarized-dark", "dark")).toBe("solarized-dark");
  });

  it("treats a single id as variant-independent", () => {
    expect(parseShikiThemePreference("nord")).toEqual({
      lightTheme: "nord",
      darkTheme: "nord",
      followsVariant: false,
    });
    expect(resolveShikiTheme("nord", "light")).toBe("nord");
    expect(resolveShikiTheme("nord", "dark")).toBe("nord");
  });
});

describe("classifyOmpTheme", () => {
  it("classifies the built-in themes by name", () => {
    expect(classifyOmpTheme({ name: "light" })).toBe("light");
    expect(classifyOmpTheme({ name: "dark" })).toBe("dark");
  });

  it("classifies custom themes from message background luminance", () => {
    expect(
      classifyOmpTheme({ name: "mine", getBgAnsi: () => "\x1b[48;2;240;240;235m" }),
    ).toBe("light");
    expect(
      classifyOmpTheme({ name: "mine", getBgAnsi: () => "\x1b[48;2;30;30;34m" }),
    ).toBe("dark");
    expect(classifyOmpTheme({ name: "mine", getBgAnsi: () => "\x1b[48;5;255m" })).toBe("light");
  });

  it("falls back to COLORFGBG when the theme carries no hint", () => {
    expect(classifyOmpTheme(undefined, { COLORFGBG: "0;15" })).toBe("light");
    expect(classifyOmpTheme(undefined, { COLORFGBG: "15;0" })).toBe("dark");
    expect(classifyOmpTheme(undefined, {})).toBeUndefined();
  });
});

describe("code preview settings", () => {
  it("defaults the shiki theme to auto", () => {
    const previous = process.env.CODE_PREVIEW_THEME;
    delete process.env.CODE_PREVIEW_THEME;
    try {
      expect(defaultCodePreviewSettings().shikiTheme).toBe("auto");
    } finally {
      if (previous !== undefined) process.env.CODE_PREVIEW_THEME = previous;
    }
  });

  it("normalizes fabric.json codePreview sections", () => {
    const settings = normalizeCodePreviewSettings({
      shikiTheme: "github-light/github-dark",
      syntaxHighlighting: false,
      editCollapsedLines: "all",
      tools: ["read", "bogus", "grep"],
      readCollapsedLines: "many",
    });
    expect(settings.shikiTheme).toBe("github-light/github-dark");
    expect(settings.syntaxHighlighting).toBe(false);
    expect(settings.editCollapsedLines).toBe("all");
    expect(settings.tools).toEqual(["read", "grep"]);
    expect(settings.readCollapsedLines).toBe(10);
  });

  it("exposes codePreview through the unified fabric config", () => {
    const configured = normalizeFabricConfig({
      codePreview: { shikiTheme: "nord", syntaxHighlighting: false },
    });
    expect(configured.codePreview.shikiTheme).toBe("nord");
    expect(configured.codePreview.syntaxHighlighting).toBe(false);
    expect(normalizeFabricConfig({}).codePreview.shikiTheme).toBe("auto");
  });
});

describe("effective shiki theme", () => {
  it("tracks OMP's resolved variant under auto", () => {
    configureHighlighting("auto", true);
    observeOmpTheme({ name: "light" });
    expect(effectiveShikiTheme()).toBe("github-light");
    expect(effectiveShikiThemeIsLight()).toBe(true);
    observeOmpTheme({ name: "dark" });
    expect(effectiveShikiTheme()).toBe("dark-plus");
    expect(effectiveShikiThemeIsLight()).toBe(false);
  });

  it("classifies unnamed custom themes by luminance", () => {
    configureHighlighting("auto", true);
    observeOmpTheme({ getBgAnsi: () => "\x1b[48;2;236;236;229m" });
    expect(observedThemeVariant()).toBe("light");
    expect(effectiveShikiTheme()).toBe("github-light");
  });

  it("keeps a fixed theme regardless of variant", () => {
    configureHighlighting("solarized-dark", true);
    observeOmpTheme({ name: "light" });
    expect(effectiveShikiTheme()).toBe("solarized-dark");
  });

  it("resolves explicit light/dark pairs against the variant", () => {
    configureHighlighting("light-plus/dark-plus", true);
    observeOmpTheme({ name: "light" });
    expect(effectiveShikiTheme()).toBe("light-plus");
    observeOmpTheme({ name: "dark" });
    expect(effectiveShikiTheme()).toBe("dark-plus");
  });
});

describe("variant-aware diff backgrounds", () => {
  it("uses light fallbacks after observing a light pi theme", () => {
    observeOmpTheme({ name: "light" });
    const resolve = createDiffBackgroundResolver(undefined, "subtle");
    expect(resolve("add")).toBe("\x1b[48;2;198;230;206m");
    expect(resolve("remove")).toBe("\x1b[48;2;242;206;210m");
  });

  it("uses dark fallbacks after observing a dark pi theme", () => {
    observeOmpTheme({ name: "dark" });
    const resolve = createDiffBackgroundResolver(undefined, "medium");
    expect(resolve("add")).toBe("\x1b[48;2;22;68;40m");
    expect(resolve("remove")).toBe("\x1b[48;2;78;36;40m");
  });
});
