import { describe, expect, it } from "vitest";
import {
  normalizeModelAliases,
  resolveAvailableOmpModel,
  resolveFabricModel,
  type FabricModelCandidate,
} from "../src/core/model-resolution.js";

const AVAILABLE: FabricModelCandidate[] = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
];

const options = (overrides: Partial<Parameters<typeof resolveFabricModel>[1]> = {}) => ({
  aliases: {},
  available: AVAILABLE,
  ...overrides,
});

describe("normalizeModelAliases", () => {
  it("keeps valid string and chain aliases verbatim", () => {
    expect(
      normalizeModelAliases({
        cheap: "google/gemini-2.5-flash",
        budget: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
      }),
    ).toEqual({
      cheap: ["google/gemini-2.5-flash"],
      budget: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
    });
  });

  it("drops malformed names and targets", () => {
    expect(
      normalizeModelAliases({
        "": "google/gemini-2.5-flash",
        "  ": "anthropic/claude-opus-4-5",
        broken: "not-a-model",
        mixed: ["openai/gpt-5-mini", "also-not-a-model"],
        empty: [],
        wrong: 42,
        alsoWrong: null,
      }),
    ).toEqual({});
  });

  it("dedupes repeated targets within a chain but preserves order", () => {
    expect(
      normalizeModelAliases({
        chain: ["google/gemini-2.5-flash", "google/gemini-2.5-flash", "openai/gpt-5-mini"],
      }),
    ).toEqual({ chain: ["google/gemini-2.5-flash", "openai/gpt-5-mini"] });
  });

  it("treats non-object input as empty", () => {
    expect(normalizeModelAliases(undefined)).toEqual({});
    expect(normalizeModelAliases(null)).toEqual({});
    expect(normalizeModelAliases(["google/gemini-2.5-flash"])).toEqual({});
  });
});

describe("resolveAvailableOmpModel", () => {
  it("accepts visible exact, fuzzy, and alias selectors", () => {
    const aliases = normalizeModelAliases({ fast: "google/gemini-2.5-flash" });
    expect(resolveAvailableOmpModel("google/gemini-2.5-pro", {
      aliases,
      available: AVAILABLE,
    })).toMatchObject({ provider: "google", id: "gemini-2.5-pro" });
    expect(resolveAvailableOmpModel("gemni-2.5-pro", {
      aliases,
      available: AVAILABLE,
    })).toMatchObject({ provider: "google", id: "gemini-2.5-pro" });
    expect(resolveAvailableOmpModel("fast", {
      aliases,
      available: AVAILABLE,
    })).toMatchObject({ provider: "google", id: "gemini-2.5-flash" });
  });

  it("rejects hidden exact IDs and exhausted aliases with a session error", () => {
    expect(() => resolveAvailableOmpModel("google/private-gemini", {
      aliases: {},
      available: AVAILABLE,
    })).toThrow(/not available to this OMP session/);
    expect(() => resolveAvailableOmpModel("retired", {
      aliases: normalizeModelAliases({
        retired: ["google/private-gemini", "anthropic/private-claude"],
      }),
      available: AVAILABLE,
    })).toThrow(/google\/private-gemini, anthropic\/private-claude/);
  });
});

describe("resolveFabricModel", () => {
  it("resolves an exact provider/id", () => {
    const resolution = resolveFabricModel("google/gemini-2.5-pro", options());
    expect(resolution).toEqual({
      kind: "resolved",
      model: { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    });
  });

  it("resolves an exact bare model id", () => {
    const resolution = resolveFabricModel("gpt-5-mini", options());
    expect(resolution).toMatchObject({ kind: "resolved", model: { id: "gpt-5-mini" } });
  });

  it("resolves a single partial match across id, name, and provider", () => {
    expect(resolveFabricModel("sonnet", options())).toMatchObject({
      kind: "resolved",
      model: { id: "claude-sonnet-4-5" },
    });
    expect(resolveFabricModel("openai", options())).toMatchObject({
      kind: "resolved",
      model: { provider: "openai" },
    });
  });

  it("resolves the closest match when a partial term matches several models", () => {
    const resolution = resolveFabricModel("gemini", options());
    expect(resolution).toMatchObject({
      kind: "resolved",
      model: { provider: "google", id: "gemini-2.5-pro" },
      via: "closest",
    });
  });

  it("prefers the most recently used model between equal-closeness matches", () => {
    const resolution = resolveFabricModel(
      "alpha",
      options({
        available: [
          { provider: "test", id: "alpha-one" },
          { provider: "test", id: "alpha-two" },
        ],
        lastUsed: { "test/alpha-one": 100, "test/alpha-two": 50 },
      }),
    );
    expect(resolution).toMatchObject({
      kind: "resolved",
      model: { provider: "test", id: "alpha-one" },
      via: "recent",
    });
  });

  it("falls to the highest-sorting key when closeness and recency tie", () => {
    const resolution = resolveFabricModel(
      "alpha",
      options({
        available: [
          { provider: "test", id: "alpha-one" },
          { provider: "test", id: "alpha-two" },
        ],
      }),
    );
    expect(resolution).toMatchObject({
      kind: "resolved",
      model: { provider: "test", id: "alpha-two" },
      via: "latest",
    });
  });

  it("fuzzy-resolves near-miss selectors to the closest model", () => {
    expect(resolveFabricModel("gemni-2.5-pro", options())).toMatchObject({
      kind: "resolved",
      model: { provider: "google", id: "gemini-2.5-pro" },
      via: "closest",
    });
    expect(resolveFabricModel("gmni", options())).toMatchObject({
      kind: "resolved",
      model: { provider: "google" },
      via: "closest",
    });
  });

  it("keeps not-found for selectors with no resemblance", () => {
    expect(resolveFabricModel("zzzz", options())).toEqual({ kind: "not-found", query: "zzzz" });
  });

  it("narrows partial matches with a provider filter", () => {
    const resolution = resolveFabricModel("claude", options({ provider: "google" }));
    expect(resolution).toEqual({ kind: "not-found", query: "claude" });
    expect(resolveFabricModel("flash", options({ provider: "google" }))).toMatchObject({
      kind: "resolved",
      model: { id: "gemini-2.5-flash" },
    });
  });

  it("resolves aliases before id matching and records the alias name", () => {
    const resolution = resolveFabricModel(
      "cheap",
      options({ aliases: normalizeModelAliases({ cheap: "google/gemini-2.5-flash" }) }),
    );
    expect(resolution).toEqual({
      kind: "resolved",
      model: { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      via: "cheap",
    });
  });

  it("falls through an alias chain to the first available target", () => {
    const resolution = resolveFabricModel(
      "Budget",
      options({
        aliases: normalizeModelAliases({ budget: ["cohere/command-r", "openai/gpt-5-mini"] }),
      }),
    );
    expect(resolution).toMatchObject({
      kind: "resolved",
      model: { id: "gpt-5-mini" },
      via: "budget",
    });
  });

  it("reports the tried chain when no alias target is available", () => {
    const resolution = resolveFabricModel(
      "budget",
      options({
        aliases: normalizeModelAliases({ budget: ["cohere/command-r", "mistral/mistral-large"] }),
      }),
    );
    expect(resolution).toEqual({
      kind: "not-found",
      query: "budget",
      tried: ["cohere/command-r", "mistral/mistral-large"],
    });
  });

  it("reports already-active without resolving again", () => {
    const resolution = resolveFabricModel("anthropic/claude-opus-4-5", options({
      current: { provider: "anthropic", id: "claude-opus-4-5" },
    }));
    expect(resolution).toEqual({
      kind: "already-active",
      model: { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    });
  });

  it("reports empty selection sets and blank queries as not-found", () => {
    expect(resolveFabricModel("anything", options({ available: [] }))).toEqual({
      kind: "not-found",
      query: "anything",
    });
    expect(resolveFabricModel("   ", options())).toEqual({ kind: "not-found", query: "   " });
  });
});
