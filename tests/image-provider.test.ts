import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import {
  ImageProvider,
  inferImageDialect,
  parseChatPayload,
  parseGeminiPayload,
  parseImagesApiPayload,
  parseResponsesPayload,
  imageDimensions,
  parseSsePayload,
  resolveImageSize,
  splitModelSelector,
} from "../src/providers/image-provider.js";
import type { FabricImageConfig } from "../src/config.js";
import type { FabricInvocationContext, FabricMediaBlock } from "../src/protocol.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 9)]);

const pngOf = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
    header,
    Buffer.alloc(120, 3),
  ]);
};

interface FakeModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
}

const model = (provider: string, id: string, api: string, baseUrl = "http://gw.test/v1"): FakeModel => ({
  provider,
  id,
  api,
  baseUrl,
});

const registryOf = (models: FakeModel[], keys: Record<string, string> = {}) => ({
  find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
  getApiKey: async (entry: unknown) => {
    const target = entry as FakeModel;
    return keys[`${target.provider}/${target.id}`] ?? "test-key";
  },
  resolveModelHeaders: async () => ({}),
});

interface Recorded {
  url: string;
  body: Record<string, unknown>;
}

const contextOf = (models: FakeModel[], media: FabricMediaBlock[], keys: Record<string, string> = {}) => {
  const registry = registryOf(models, keys);
  return {
    cwd: process.cwd(),
    signal: undefined,
    attachMedia: (blocks: FabricMediaBlock[]) => media.push(...blocks),
    extensionContext: { modelRegistry: registry, sessionManager: { getSessionId: () => "session-1" } },
  } as unknown as FabricInvocationContext;
};

const configOf = (overrides: Partial<FabricImageConfig> = {}): FabricImageConfig => ({
  ...DEFAULT_FABRIC_CONFIG.image,
  retries: 0,
  ...overrides,
});

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const chatPayload = (base64: string) => ({
  choices: [{ message: { role: "assistant", content: `Here you go:\n\n![image](data:image/jpeg;base64,${base64})` } }],
});

const responsesPayload = (base64: string) => ({
  status: "completed",
  output: [{ type: "image_generation_call", result: base64, status: "completed" }],
});

const imagesPayload = (base64: string) => ({ data: [{ b64_json: base64 }] });

const geminiPayload = (base64: string) => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: base64 } }] } }],
});

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fabric-image-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("image dialect inference", () => {
  it("maps each api family to its request shape", () => {
    expect(inferImageDialect("openai-images", "gpt-image-2")).toBe("images");
    expect(inferImageDialect("openrouter-images", "google/gemini-3-pro-image")).toBe("images");
    expect(inferImageDialect("google-generative-ai", "gemini-3-pro-image")).toBe("gemini");
    expect(inferImageDialect("openai-completions", "gemini-3.1-flash-image")).toBe("chat");
    expect(inferImageDialect("anthropic-messages", "whatever")).toBe("chat");
  });

  it("prefers the images API for image-named models on a responses provider", () => {
    expect(inferImageDialect("openai-responses", "antigravity/gemini-3.1-flash-image")).toBe("images");
    expect(inferImageDialect("openai-responses", "cx/gpt-6.1-sol")).toBe("responses");
  });

  it("splits a selector at the first slash so nested model ids survive", () => {
    expect(splitModelSelector("xai-hm/antigravity/gemini-3.1-flash-image")).toEqual({
      provider: "xai-hm",
      id: "antigravity/gemini-3.1-flash-image",
    });
    expect(splitModelSelector("no-slash")).toBeUndefined();
    expect(splitModelSelector("/leading")).toBeUndefined();
  });
});

describe("image payload parsing", () => {
  it("reads a chat reply that carries the image as a markdown data URL", () => {
    expect(parseChatPayload(chatPayload(JPEG.toString("base64")))).toEqual([
      { data: JPEG.toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  it("reads the hosted responses image_generation_call result", () => {
    expect(parseResponsesPayload(responsesPayload(PNG.toString("base64")))).toEqual([
      { data: PNG.toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("ignores a failed hosted call and text-only replies", () => {
    expect(parseResponsesPayload({ status: "failed", output: [{ type: "image_generation_call", result: "" }] })).toEqual([]);
    expect(parseChatPayload({ choices: [{ message: { content: "I cannot draw that." } }] })).toEqual([]);
  });

  it("reads the images API and gemini inline parts", () => {
    expect(parseImagesApiPayload(imagesPayload(JPEG.toString("base64")))).toHaveLength(1);
    expect(parseGeminiPayload(geminiPayload(PNG.toString("base64")))).toHaveLength(1);
  });

  it("rejects payload bytes that are not an image", () => {
    const notAnImage = Buffer.alloc(200, 1).toString("base64");
    expect(parseImagesApiPayload(imagesPayload(notAnImage))).toEqual([]);
  });
});

describe("ImageProvider priority chain", () => {
  it("walks the chain in order and reports the model that produced bytes", async () => {
    const models = [
      model("sub2api-agy", "gemini-3.1-flash-image", "openai-completions"),
      model("xai-hm", "antigravity/gemini-3.1-flash-image", "openai-responses", "http://xai.test/v1"),
    ];
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url.includes("gw.test")) return jsonResponse({ error: "upstream down" }, 503);
      return jsonResponse(imagesPayload(JPEG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const media: FabricMediaBlock[] = [];
    const provider = new ImageProvider(() => configOf({ models: models.map((m) => `${m.provider}/${m.id}`), outputDir: dir }), {
      fetchImpl,
    });

    const result = (await provider.invoke("generate", { prompt: "a red circle" }, contextOf(models, media))) as {
      ok: boolean;
      model: string;
      dialect: string;
      images: Array<{ path: string; bytes: number }>;
      failures: unknown[];
    };

    expect(result.ok).toBe(true);
    expect(result.model).toBe("xai-hm/antigravity/gemini-3.1-flash-image");
    expect(result.dialect).toBe("images");
    expect(result.failures).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual([
      "http://gw.test/v1/chat/completions",
      "http://xai.test/v1/images/generations",
    ]);
    expect(await readFile(result.images[0]!.path)).toHaveLength(result.images[0]!.bytes);
    expect(media).toHaveLength(1);
    expect(media[0]!.mimeType).toBe("image/jpeg");
  });

  it("retries a transient failure on the same model before moving on", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse({ status: "failed", output: [] });
      return jsonResponse(responsesPayload(PNG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], retries: 1, outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke("generate", { prompt: "a circle" }, contextOf(models, []))) as {
      ok: boolean;
      attempts: number;
    };

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(attempt).toBe(2);
  });

  it("returns a failure report instead of throwing when every model fails", async () => {
    const models = [model("sub2api-agy", "gemini-3.1-flash-image", "openai-completions")];
    const fetchImpl = (async () => jsonResponse({ error: "no image" }, 500)) as unknown as typeof fetch;
    const provider = new ImageProvider(() => configOf({ models: ["sub2api-agy/gemini-3.1-flash-image"] }), {
      fetchImpl,
    });

    const result = (await provider.invoke("generate", { prompt: "x" }, contextOf(models, []))) as {
      ok: boolean;
      failures: Array<{ status?: number; error: string }>;
    };

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.status).toBe(500);
    expect(result.failures[0]?.error).toContain("returned 500");
  });

  it("refuses to run with no configured models", async () => {
    const provider = new ImageProvider(() => configOf({ models: [] }));
    const result = (await provider.invoke("generate", { prompt: "x" }, contextOf([], []))) as {
      ok: boolean;
      reason: string;
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no image models configured");
  });

  it("sends responses edits as input_image parts", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(responsesPayload(PNG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "edit",
      { prompt: "make it blue", images: [`data:image/jpeg;base64,${JPEG.toString("base64")}`] },
      contextOf(models, []),
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    const input = calls[0]?.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content[1]).toMatchObject({ type: "input_image" });
    expect(calls[0]?.body.tool_choice).toEqual({ type: "image_generation" });
  });

  it("sends chat edits as image_url parts", async () => {
    const models = [model("sub2api-agy", "gemini-3.1-flash-image", "openai-completions")];
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(chatPayload(JPEG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["sub2api-agy/gemini-3.1-flash-image"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "edit",
      { prompt: "make it blue", images: [`data:image/jpeg;base64,${JPEG.toString("base64")}`] },
      contextOf(models, []),
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    const messages = calls[0]?.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[1]).toMatchObject({ type: "image_url" });
  });

  it("lists the resolved chain with dialect and credential state", async () => {
    const models = [
      model("sub2api-agy", "gemini-3.1-flash-image", "openai-completions"),
      model("xai-hm", "antigravity/gemini-3.1-flash-image", "openai-responses"),
    ];
    const provider = new ImageProvider(() =>
      configOf({ models: ["sub2api-agy/gemini-3.1-flash-image", "xai-hm/antigravity/gemini-3.1-flash-image"] }),
    );

    const result = (await provider.invoke("models", {}, contextOf(models, []))) as {
      models: Array<{ selector: string; dialect: string; credentials: boolean }>;
    };

    expect(result.models.map((entry) => entry.dialect)).toEqual(["chat", "images"]);
    expect(result.models.every((entry) => entry.credentials)).toBe(true);
  });

  it("honours a configured dialect override", async () => {
    const models = [model("xai-hm", "antigravity/gemini-3.1-flash-image", "openai-responses")];
    const provider = new ImageProvider(() =>
      configOf({
        models: ["xai-hm/antigravity/gemini-3.1-flash-image"],
        dialects: { "xai-hm/antigravity/gemini-3.1-flash-image": "responses" },
      }),
    );
    const result = (await provider.invoke("models", {}, contextOf(models, []))) as {
      models: Array<{ dialect: string }>;
    };
    expect(result.models[0]?.dialect).toBe("responses");
  });
});

describe("image provider failure paths", () => {
  it("skips a model whose credential lookup rejects and keeps walking", async () => {
    const models = [
      model("broken", "img", "openai-images", "http://broken.test/v1"),
      model("xai-hm", "antigravity/gemini-3.1-flash-image", "openai-responses", "http://xai.test/v1"),
    ];
    const fetchImpl = (async (input: string) =>
      String(input).includes("broken.test")
        ? jsonResponse(imagesPayload(JPEG.toString("base64")))
        : jsonResponse(imagesPayload(JPEG.toString("base64")))) as unknown as typeof fetch;
    const registry = {
      find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
      getApiKey: async (entry: unknown) => {
        const target = entry as FakeModel;
        if (target.provider === "broken") throw new Error("OAuthRefreshUnavailableError");
        return "test-key";
      },
      resolveModelHeaders: async () => ({}),
    };
    const context = {
      cwd: process.cwd(),
      signal: undefined,
      attachMedia: () => {},
      extensionContext: { modelRegistry: registry, sessionManager: { getSessionId: () => "s" } },
    } as unknown as FabricInvocationContext;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({
        models: ["broken/img", "xai-hm/antigravity/gemini-3.1-flash-image"],
        outputDir: dir,
      }),
      { fetchImpl },
    );

    const result = (await provider.invoke("generate", { prompt: "x" }, context)) as {
      ok: boolean;
      model: string;
      failures: Array<{ error: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.model).toBe("xai-hm/antigravity/gemini-3.1-flash-image");
    expect(result.failures[0]?.error).toContain("credential lookup failed");
  });

  it("authenticates a google-generative-ai model with x-goog-api-key", async () => {
    const models = [model("google", "gemini-3.1-flash-image", "google-generative-ai", "https://gl.test")];
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      return jsonResponse(geminiPayload(PNG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["google/gemini-3.1-flash-image"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke("generate", { prompt: "x" }, contextOf(models, []))) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(headers[0]?.["x-goog-api-key"]).toBe("test-key");
    expect(headers[0]?.Authorization).toBeUndefined();
  });

  it("posts an openrouter-images model to /images with image_size and input_references", async () => {
    const models = [model("openrouter", "openai/gpt-image-2", "openrouter-images", "https://or.test/v1")];
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(imagesPayload(JPEG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["openrouter/openai/gpt-image-2"], outputDir: dir }),
      { fetchImpl },
    );

    await provider.invoke(
      "edit",
      { prompt: "x", size: "1536x1024", images: [`data:image/jpeg;base64,${JPEG.toString("base64")}`] },
      contextOf(models, []),
    );

    expect(calls[0]?.url).toBe("https://or.test/v1/images");
    expect(calls[0]?.body.image_size).toBe("1536x1024");
    expect(calls[0]?.body.input_references).toHaveLength(1);
  });

  it("omits response_format for a gpt-image model", async () => {
    const models = [model("openai", "gpt-image-2", "openai-images", "https://api.test/v1")];
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(imagesPayload(PNG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["openai/gpt-image-2"], outputDir: dir }),
      { fetchImpl },
    );

    await provider.invoke("generate", { prompt: "x" }, contextOf(models, []));

    expect(calls[0]?.body).not.toHaveProperty("response_format");
  });

  it("reports a write failure once instead of retrying the model", async () => {
    const models = [model("xai-hm", "antigravity/gemini-3.1-flash-image", "openai-responses", "http://xai.test/v1")];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(imagesPayload(JPEG.toString("base64")));
    }) as unknown as typeof fetch;
    const blocker = path.join(await tempDir(), "blocker");
    await writeFile(blocker, "not a directory");
    const provider = new ImageProvider(
      () => configOf({
        models: ["xai-hm/antigravity/gemini-3.1-flash-image"],
        retries: 2,
        outputDir: path.join(blocker, "nested"),
      }),
      { fetchImpl },
    );

    const result = (await provider.invoke("generate", { prompt: "x" }, contextOf(models, []))) as {
      ok: boolean;
      reason: string;
    };

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("the write failed");
    expect(calls).toBe(1);
  });

  it("runs from a mount-injected registry when the invocation context carries none", async () => {
    const models = [model("xai-hm", "antigravity/gemini-3.1-flash-image", "openai-responses", "http://xai.test/v1")];
    const fetchImpl = (async () => jsonResponse(imagesPayload(JPEG.toString("base64")))) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/antigravity/gemini-3.1-flash-image"], outputDir: dir }),
      { fetchImpl, registry: registryOf(models), getSessionId: () => "mounted" },
    );
    const supervisorContext = {
      cwd: process.cwd(),
      signal: undefined,
      extensionContext: {},
    } as unknown as FabricInvocationContext;

    const result = (await provider.invoke("generate", { prompt: "x" }, supervisorContext)) as {
      ok: boolean;
      model: string;
    };

    expect(result.ok).toBe(true);
    expect(result.model).toBe("xai-hm/antigravity/gemini-3.1-flash-image");
  });

  it("maps each supported ratio onto a concrete pixel size", () => {
    expect(resolveImageSize("1:1", undefined)).toBe("1024x1024");
    expect(resolveImageSize("3:4", undefined)).toBe("1024x1536");
    expect(resolveImageSize("16:9", undefined)).toBe("1536x1024");
    expect(resolveImageSize("1:1", "1536x1024")).toBe("1536x1024");
    expect(resolveImageSize("5:4", undefined)).toBeUndefined();
    expect(resolveImageSize(undefined, undefined)).toBeUndefined();
  });

  it("maps aspectRatio onto the hosted image tool size", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse(responsesPayload(PNG.toString("base64")));
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", aspectRatio: "1:1" },
      contextOf(models, []),
    )) as { ok: boolean; ignored?: string[] };

    expect(result.ok).toBe(true);
    expect(result.ignored).toBeUndefined();
    const tools = calls[0]?.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "image_generation", action: "generate", size: "1024x1024" });
  });

  it("marks the aspectRatio the hosted tool cannot represent as ignored", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    const fetchImpl = (async () => jsonResponse(responsesPayload(PNG.toString("base64")))) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", aspectRatio: "5:4" },
      contextOf(models, []),
    )) as { ok: boolean; ignored?: string[] };

    expect(result.ok).toBe(true);
    expect(result.ignored).toEqual(["aspectRatio"]);
  });

  it("reports that the chat dialect drops size and aspectRatio", async () => {
    const models = [model("sub2api-agy", "gemini-3.1-flash-image", "openai-completions")];
    const fetchImpl = (async () => jsonResponse(chatPayload(JPEG.toString("base64")))) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["sub2api-agy/gemini-3.1-flash-image"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", aspectRatio: "1:1", size: "1024x1024" },
      contextOf(models, []),
    )) as { ok: boolean; ignored?: string[] };

    expect(result.ok).toBe(true);
    expect(result.ignored).toEqual(["aspectRatio", "size"]);
  });

  it("reports count when the dialect can only return one image", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    const fetchImpl = (async () => jsonResponse(responsesPayload(PNG.toString("base64")))) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", count: 3 },
      contextOf(models, []),
    )) as { ok: boolean; ignored?: string[] };

    expect(result.ok).toBe(true);
    expect(result.ignored).toEqual(["count"]);
  });

  it("reports saveTo when more than one image comes back", async () => {
    const models = [model("openai", "gpt-image-2", "openai-images", "https://api.test/v1")];
    const two = { data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64") }] };
    const fetchImpl = (async () => jsonResponse(two)) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["openai/gpt-image-2"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", count: 2, saveTo: path.join(dir, "one.png") },
      contextOf(models, []),
    )) as { ok: boolean; ignored?: string[]; images: unknown[] };

    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(2);
    expect(result.ignored).toEqual(["saveTo"]);
  });

  it("reads PNG and JPEG dimensions from the header", () => {
    expect(imageDimensions(pngOf(1024, 1024))).toEqual({ width: 1024, height: 1024 });
    expect(imageDimensions(pngOf(2172, 724))).toEqual({ width: 2172, height: 724 });
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      Buffer.from([0x04, 0x00, 0x06, 0x00]),
      Buffer.alloc(64, 0),
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 1536, height: 1024 });
    expect(imageDimensions(Buffer.alloc(8, 1))).toBeUndefined();
  });

  it("reports the size the backend actually produced and flags a mismatch", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    const odd = pngOf(2172, 724);
    const fetchImpl = (async () =>
      jsonResponse(responsesPayload(odd.toString("base64")))) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", aspectRatio: "16:9" },
      contextOf(models, []),
    )) as {
      ok: boolean;
      requestedSize?: string;
      sizeHonoured?: false;
      images: Array<{ width?: number; height?: number }>;
    };

    expect(result.ok).toBe(true);
    expect(result.requestedSize).toBe("1536x1024");
    expect(result.images[0]).toMatchObject({ width: 2172, height: 724 });
    expect(result.sizeHonoured).toBe(false);
  });

  it("leaves sizeHonoured unset when the backend matches the request", async () => {
    const models = [model("xai-hm", "cx/gpt-6.1-sol", "openai-responses", "http://xai.test/v1")];
    const square = pngOf(1024, 1024);
    const fetchImpl = (async () =>
      jsonResponse(responsesPayload(square.toString("base64")))) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["xai-hm/cx/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke(
      "generate",
      { prompt: "x", aspectRatio: "1:1" },
      contextOf(models, []),
    )) as { ok: boolean; requestedSize?: string; sizeHonoured?: false; images: Array<{ width?: number }> };

    expect(result.ok).toBe(true);
    expect(result.requestedSize).toBe("1024x1024");
    expect(result.images[0]?.width).toBe(1024);
    expect(result.sizeHonoured).toBeUndefined();
  });

  it("declares a write risk because it writes files", async () => {
    const provider = new ImageProvider(() => configOf({ models: ["a/b"] }));
    const context = contextOf([], []);
    const risks = await Promise.all(
      ["generate", "edit", "models"].map(async (name) => (await provider.describe(name, context))?.risk),
    );
    expect(risks).toEqual(["write", "write", "read"]);
  });

  it("takes the last response event from a stream and skips keep-alives", () => {
    const first = { type: "response.created", response: { status: "in_progress", output: [] } };
    const last = responsesPayload(PNG.toString("base64"));
    const stream = [
      `data: ${JSON.stringify(first)}`,
      "",
      "data: [DONE]",
      `data: ${JSON.stringify({ type: "response.completed", response: last })}`,
      "",
    ].join("\n");

    expect(parseSsePayload(stream)).toEqual(last);
    expect(() => parseSsePayload("data: [DONE]\n")).toThrow("no response payload");
  });

  it("reads a codex event stream and posts to /codex/responses", async () => {
    const models = [model("openai-codex", "gpt-6.1-sol", "openai-codex-responses", "https://chatgpt.test/backend-api")];
    const calls: Recorded[] = [];
    const payload = responsesPayload(PNG.toString("base64"));
    const sse = `data: ${
      JSON.stringify({ type: "response.completed", response: payload })
    }\n\ndata: [DONE]\n`;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const dir = await tempDir();
    const provider = new ImageProvider(
      () => configOf({ models: ["openai-codex/gpt-6.1-sol"], outputDir: dir }),
      { fetchImpl },
    );

    const result = (await provider.invoke("generate", { prompt: "x" }, contextOf(models, []))) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://chatgpt.test/backend-api/codex/responses");
    expect(calls[0]?.body.stream).toBe(true);
  });
});

describe("image config normalization", () => {
  it("keeps order, drops duplicates and invalid selectors, and caps the chain", () => {
    const config = normalizeFabricConfig({
      image: {
        models: [
          "xai-hm/antigravity/gemini-3.1-flash-image",
          "sub2api-agy/gemini-3.1-flash-image",
          "sub2api-agy/gemini-3.1-flash-image",
          "no-slash",
          "",
          ...Array.from({ length: 12 }, (_unused, index) => `prov/m${index}`),
        ],
      },
    });

    expect(config.image.models[0]).toBe("xai-hm/antigravity/gemini-3.1-flash-image");
    expect(config.image.models[1]).toBe("sub2api-agy/gemini-3.1-flash-image");
    expect(config.image.models).toHaveLength(10);
    expect(new Set(config.image.models).size).toBe(10);
  });

  it("drops unknown dialect values and keeps the known ones", () => {
    const config = normalizeFabricConfig({
      image: {
        models: ["a/b"],
        dialects: { "a/b": "images", "c/d": "carrier-pigeon" },
      },
    });
    expect(config.image.dialects).toEqual({ "a/b": "images" });
  });

  it("defaults to enabled with an empty chain and bounded retries", () => {
    const config = normalizeFabricConfig({ image: { retries: 99, timeoutMs: 1 } });
    expect(config.image.enabled).toBe(true);
    expect(config.image.models).toEqual([]);
    expect(config.image.retries).toBe(4);
    expect(config.image.timeoutMs).toBe(5_000);
  });
});
