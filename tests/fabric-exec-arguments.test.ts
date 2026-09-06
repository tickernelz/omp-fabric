import { describe, expect, it } from "vitest";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";

describe("prepareFabricExecArguments", () => {
  it("keeps canonical arguments unchanged", () => {
    const input = { code: "return 1;", tokenBudget: 10 };
    expect(prepareFabricExecArguments(input)).toBe(input);
    const withPayloads = { code: "return 1;", payloads: { body: "ok" } };
    expect(prepareFabricExecArguments(withPayloads)).toBe(withPayloads);
  });

  it("wraps a root code string before schema validation", () => {
    expect(prepareFabricExecArguments("return 1;")).toEqual({ code: "return 1;" });
  });

  it("joins all-string code arrays and leaves malformed arrays invalid", () => {
    expect(prepareFabricExecArguments({ code: ["const x = 1;", "return x;"] })).toEqual({
      code: "const x = 1;\nreturn x;",
    });
    const malformed = { code: ["return ", 1] };
    expect(prepareFabricExecArguments(malformed)).toBe(malformed);
  });

  it("omits null optional fields but preserves a null required code", () => {
    expect(prepareFabricExecArguments({
      code: null,
      payloads: null,
      resultFormat: null,
      tokenBudget: null,
      agentBudget: undefined,
      display: null,
    })).toEqual({ code: null });
  });

  it("canonicalizes display shorthands before execution", () => {
    expect(prepareFabricExecArguments({ code: "return 1;", display: "Probe" })).toEqual({
      code: "return 1;",
      display: { name: "Probe" },
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      display: '{"name":"Probe","description":"check"}',
    })).toEqual({
      code: "return 1;",
      display: { name: "Probe", description: "check" },
    });
  });

  it("normalizes canonical payloads", () => {
    expect(prepareFabricExecArguments({
      code: "return payloads.body;",
      payloads: { body: "canonical" },
    })).toEqual({
      code: "return payloads.body;",
      payloads: { body: "canonical" },
    });
  });

  it("parses JSON-object payload maps before schema validation", () => {
    const payload = { lifecycle: "#!/bin/sh\n# inventory" };
    expect(prepareFabricExecArguments({
      code: "return omp.lifecycle;",
      payloads: JSON.stringify(payload),
    })).toEqual({
      code: "return omp.lifecycle;",
      payloads: payload,
    });
    expect(prepareFabricExecArguments({
      code: "return payloads.body;",
      payloads: JSON.stringify(JSON.stringify({ body: "ok" })),
    })).toEqual({
      code: "return payloads.body;",
      payloads: { body: "ok" },
    });
  });

  it("leaves malformed payload maps invalid on the canonical key", () => {
    expect(prepareFabricExecArguments({
      code: "return 1;",
      payloads: "not-json",
    })).toEqual({
      code: "return 1;",
      payloads: "not-json",
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      payloads: '["lifecycle"]',
    })).toEqual({
      code: "return 1;",
      payloads: '["lifecycle"]',
    });
    expect(prepareFabricExecArguments({
      code: "return 1;",
      payloads: '{"n":1}',
    })).toEqual({
      code: "return 1;",
      payloads: '{"n":1}',
    });
  });
});
