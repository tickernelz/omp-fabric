import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

const proxyNames = {
  extensions: ["generate_image", "telegram_message"],
  mcp: {
    vidwatch: ["list_watched", "ask_video"],
    context7: ["query-docs"],
  },
};

describe("enumerable guest provider proxies", () => {
  it("enumerates extension and mcp names without any host call", async () => {
    const hostCall = vi.fn(async () => undefined);
    const result = await new QuickJsRuntime().execute(
      `
return {
  extensions: Object.keys(extensions),
  mcpServers: Object.keys(mcp),
  vidwatch: Object.keys(mcp.vidwatch),
  context7: Object.keys(mcp.context7),
};
`,
      hostCall,
      { ...options, proxyNames },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      extensions: ["generate_image", "telegram_message"],
      mcpServers: ["context7", "vidwatch", "servers", "reload", "register", "call"],
      vidwatch: ["ask_video", "list_watched"],
      context7: ["query-docs"],
    });
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("enumerates nothing when the providers have no descriptors yet", async () => {
    const hostCall = vi.fn(async () => undefined);
    const result = await new QuickJsRuntime().execute(
      `return { extensions: Object.keys(extensions), mcp: Object.keys(mcp) };`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      extensions: [],
      mcp: ["servers", "reload", "register", "call"],
    });
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("keeps every enumerated name callable and dispatches to its ref", async () => {
    const refs: string[] = [];
    const hostCall = vi.fn(async (ref: string) => {
      refs.push(ref);
      return ref;
    });
    const result = await new QuickJsRuntime().execute(
      `
const out = [];
for (const server of Object.keys(mcp)) {
  for (const tool of Object.keys(mcp[server])) {
    out.push(await mcp[server][tool]({}));
  }
}
for (const name of Object.keys(extensions)) out.push(await extensions[name]({}));
return out;
`,
      hostCall,
      { ...options, proxyNames },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([
      "mcp.context7.query-docs",
      "mcp.vidwatch.ask_video",
      "mcp.vidwatch.list_watched",
      "extensions.generate_image",
      "extensions.telegram_message",
    ]);
    expect(refs).toHaveLength(5);
  });

  it("keeps mcp management helpers callable and enumerated", async () => {
    const hostCall = vi.fn(async (ref: string) => ref);
    const result = await new QuickJsRuntime().execute(
      `
const listed = await mcp.servers();
return { listed, keys: Object.keys(mcp), hasServers: "servers" in mcp, hasVidwatch: "vidwatch" in mcp };
`,
      hostCall,
      { ...options, proxyNames },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      listed: "mcp.$servers",
      keys: ["context7", "vidwatch", "servers", "reload", "register", "call"],
      hasServers: true,
      hasVidwatch: true,
    });
  });

  it("keeps memory.walk enumerable on a provider proxy with no descriptor names", async () => {
    const hostCall = vi.fn(async () => undefined);
    const result = await new QuickJsRuntime().execute(
      `return { memory: Object.keys(memory), state: Object.keys(state) };`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ memory: ["walk"], state: [] });
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("flattens server enumeration to exactly the mcp tool refs", async () => {
    const hostCall = vi.fn(async (ref: string) => ref);
    const result = await new QuickJsRuntime().execute(
      `
const refs = [];
for (const server of Object.keys(mcp)) {
  for (const tool of Object.keys(mcp[server])) refs.push("mcp." + server + "." + tool);
}
return refs.sort();
`,
      hostCall,
      { ...options, proxyNames },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([
      "mcp.context7.query-docs",
      "mcp.vidwatch.ask_video",
      "mcp.vidwatch.list_watched",
    ]);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("spreads enumerated names into callables", async () => {
    const hostCall = vi.fn(async (ref: string) => ref);
    const result = await new QuickJsRuntime().execute(
      `
const spread = { ...extensions };
return { keys: Object.keys(spread), value: await spread.generate_image({}) };
`,
      hostCall,
      { ...options, proxyNames },
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      keys: ["generate_image", "telegram_message"],
      value: "extensions.generate_image",
    });
  });
});
