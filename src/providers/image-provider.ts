import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FabricImageConfig, FabricImageDialect } from "../config.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

interface ImageModelRef {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
  gptImage: boolean;
  codex: boolean;
  xai: boolean;
}

interface ImageModelRegistry {
  find(provider: string, modelId: string): unknown;
  getApiKey(model: unknown, sessionId?: string): Promise<string | undefined>;
  resolveModelHeaders?(model: unknown, signal?: AbortSignal): Promise<Record<string, string> | undefined>;
}

export interface InlineImage {
  data: string;
  mimeType: string;
}

interface ImageAttempt {
  model: string;
  dialect: FabricImageDialect;
  error: string;
  status?: number;
}

interface RequestEnv {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  fetchImpl: typeof fetch;
}

const IMAGE_MODEL_API = /image|imagen|dall-e|flux|stable-diffusion|sdxl|seedream|kolors|wanx|cogview|recraft|ideogram|midjourney|horde|banana/i;

const generateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "Full image description; the only required argument." },
    model: {
      type: "string",
      description: 'Optional provider/id to try first, e.g. "sub2api-agy/gemini-3.1-flash-image". Falls back to the configured chain.',
    },
    aspectRatio: {
      type: "string",
      description: "Aspect ratio forwarded as aspect_ratio or imageConfig.aspectRatio, e.g. 1:1, 16:9, 9:16.",
    },
    size: {
      type: "string",
      enum: ["1024x1024", "1536x1024", "1024x1536"],
      description: "Pixel size for gateways that accept an images-API size field.",
    },
    count: { type: "number", description: "Images to request from one model; only the images API honours more than one." },
    saveTo: { type: "string", description: "Absolute or cwd-relative file path for a single image." },
  },
} as const;

const editSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "images"],
  properties: {
    prompt: { type: "string", description: "What to change in the source images." },
    images: {
      type: "array",
      minItems: 1,
      description: "Source images as file paths or data URLs.",
      items: { type: "string" },
    },
    model: { type: "string", description: "Optional provider/id to try first." },
    aspectRatio: { type: "string", description: "Aspect ratio forwarded to the backend." },
    size: {
      type: "string",
      enum: ["1024x1024", "1536x1024", "1024x1536"],
      description: "Pixel size for gateways that accept an images-API size field.",
    },
    saveTo: { type: "string", description: "Absolute or cwd-relative file path for a single image." },
  },
} as const;

const modelsSchema = { type: "object", additionalProperties: false, properties: {} } as const;

const descriptors: FabricActionDescriptor[] = [
  {
    name: "generate",
    description:
      "Generate an image from a prompt. Tries each configured model in priority order and returns the first success with its path, bytes, model, and dialect. Returns { ok: false, reason, failures } instead of throwing when every model fails.",
    inputSchema: generateSchema as unknown as Record<string, unknown>,
    risk: "write",
  },
  {
    name: "edit",
    description:
      "Edit existing images with a prompt. Tries each configured model in priority order and returns the first success or { ok: false, reason, failures }. Source images travel in the shape each dialect expects: input_references or image/images for the images API, image_url parts for chat, input_image for responses, inlineData for gemini.",
    inputSchema: editSchema as unknown as Record<string, unknown>,
    risk: "write",
  },
  {
    name: "models",
    description:
      "Show the resolved priority chain: each entry's provider, model id, api, inferred or overridden dialect, and whether credentials resolve. No network call.",
    inputSchema: modelsSchema as unknown as Record<string, unknown>,
    risk: "read",
  },
];

export const splitModelSelector = (selector: string): { provider: string; id: string } | undefined => {
  const trimmed = selector.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
};

export const inferImageDialect = (api: string, modelId: string): FabricImageDialect => {
  if (api === "openai-images" || api === "openrouter-images") return "images";
  if (api === "google-generative-ai") return "gemini";
  if (api === "openai-responses" || api === "openai-codex-responses") {
    return IMAGE_MODEL_API.test(modelId) ? "images" : "responses";
  }
  return "chat";
};

const GPT_IMAGE_FAMILY = /gpt-image|chatgpt-image/i;

const mimeFromMagic = (bytes: Buffer): string | undefined => {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 6 && bytes.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
};

const extensionForMime = (mimeType: string): string => {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
};

const MAGIC_SNIFF_BASE64_CHARS = 64;

const decodeImage = (value: unknown): InlineImage | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let base64 = value;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma < 0) return undefined;
    base64 = value.slice(comma + 1);
  }
  const head = Buffer.from(base64.slice(0, MAGIC_SNIFF_BASE64_CHARS), "base64");
  if (head.length < 16) return undefined;
  const mimeType = mimeFromMagic(head);
  if (mimeType === undefined) return undefined;
  return { data: base64, mimeType };
};

const collectFromUrlList = (value: unknown): InlineImage[] => {
  if (!Array.isArray(value)) return [];
  const images: InlineImage[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const decoded = decodeImage(entry);
      if (decoded) images.push(decoded);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const nested = record.image_url;
    const url =
      typeof nested === "string"
        ? nested
        : typeof nested === "object" && nested !== null
          ? (nested as Record<string, unknown>).url
          : record.url;
    const decoded = decodeImage(url);
    if (decoded) images.push(decoded);
  }
  return images;
};

const DATA_URL_PATTERN = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/gi;

export const parseImagesApiPayload = (payload: unknown): InlineImage[] => {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const images: InlineImage[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const decoded = decodeImage(record.b64_json) ?? decodeImage(record.url);
    if (decoded) images.push(decoded);
  }
  return images;
};

export const parseResponsesPayload = (payload: unknown): InlineImage[] => {
  const output = (payload as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return [];
  const images: InlineImage[] = [];
  for (const entry of output) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "image_generation_call") continue;
    const decoded = decodeImage(record.result);
    if (decoded) images.push(decoded);
  }
  return images;
};

export const parseChatPayload = (payload: unknown): InlineImage[] => {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const message = (choices[0] as { message?: Record<string, unknown> } | null)?.message;
  if (!message) return [];
  const direct = collectFromUrlList(message.images);
  if (direct.length > 0) return direct;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string"
                ? String((part as Record<string, unknown>).text)
                : "",
            )
            .join("\n")
        : "";
  const images: InlineImage[] = [];
  for (const match of text.matchAll(DATA_URL_PATTERN)) {
    const decoded = decodeImage(match[0]);
    if (decoded) images.push(decoded);
  }
  if (images.length > 0) return images;
  return collectFromUrlList(
    Array.isArray(content)
      ? content.filter(
          (part) =>
            typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "image_url",
        )
      : [],
  );
};

export const parseGeminiPayload = (payload: unknown): InlineImage[] => {
  const candidates = (payload as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return [];
  const images: InlineImage[] = [];
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } } | null)?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const inline = (part as Record<string, unknown>).inlineData ?? (part as Record<string, unknown>).inline_data;
      if (typeof inline !== "object" || inline === null) continue;
      const record = inline as Record<string, unknown>;
      const decoded = decodeImage(record.data);
      if (decoded) images.push(decoded);
    }
  }
  return images;
};

const joinUrl = (baseUrl: string, suffix: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${suffix.startsWith("/") ? suffix : "/" + suffix}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface CallOptions {
  prompt: string;
  aspectRatio?: string | undefined;
  size?: string | undefined;
  count: number;
  inputImages: InlineImage[];
  signal: AbortSignal | undefined;
}

const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

const postJson = async (
  env: RequestEnv,
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ payload: unknown; status: number; contentType: string }> => {
  const response = await env.fetchImpl(url, {
    method: "POST",
    headers: { ...env.headers, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    ...(env.signal ? { signal: env.signal } : {}),
  });
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error(`${url} declared ${declared} bytes, over the ${MAX_RESPONSE_BYTES} ceiling`), {
      status: 413,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`), {
      status: response.status,
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return { payload: parseSsePayload(text), status: response.status, contentType };
  }
  try {
    return { payload: JSON.parse(text) as unknown, status: response.status, contentType };
  } catch {
    throw new Error(`${url} returned non-JSON: ${text.slice(0, 200)}`);
  }
};

export const parseSsePayload = (text: string): unknown => {
  let last: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const nested = event.response;
    if (isRecord(nested) && Array.isArray(nested.output)) {
      last = nested;
      continue;
    }
    if (Array.isArray(event.output)) last = event;
  }
  if (last === undefined) throw new Error("event stream carried no response payload");
  return last;
};

const dataUrl = (image: InlineImage): string => `data:${image.mimeType};base64,${image.data}`;

const requestImages = async (env: RequestEnv, model: ImageModelRef, options: CallOptions): Promise<InlineImage[]> => {
  const openrouter = model.api === "openrouter-images";
  const body: Record<string, unknown> = { model: model.id, prompt: options.prompt, n: options.count };
  if (!model.gptImage) body.response_format = "b64_json";
  if (options.size !== undefined) {
    if (openrouter) body.image_size = options.size;
    else body.size = options.size;
  }
  if (options.aspectRatio !== undefined) body.aspect_ratio = options.aspectRatio;
  const references = options.inputImages.map((image) => ({ type: "image_url", url: dataUrl(image) }));

  if (options.inputImages.length === 0) {
    const url = joinUrl(env.baseUrl, openrouter ? "/images" : "/images/generations");
    const { payload } = await postJson(env, url, body);
    return parseImagesApiPayload(payload);
  }

  if (model.provider === "openai") {
    const form = new FormData();
    form.set("model", model.id);
    form.set("prompt", options.prompt);
    form.set("n", String(options.count));
    if (!model.gptImage) form.set("response_format", "b64_json");
    if (options.size !== undefined) form.set("size", options.size);
    for (const image of options.inputImages) {
      form.append("image", new File([Buffer.from(image.data, "base64")], "image", { type: image.mimeType }));
    }
    const response = await env.fetchImpl(joinUrl(env.baseUrl, "/images/edits"), {
      method: "POST",
      headers: env.headers,
      body: form,
      ...(env.signal ? { signal: env.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`images edit returned ${response.status}: ${text.slice(0, 400)}`), {
        status: response.status,
      });
    }
    return parseImagesApiPayload(JSON.parse(text) as unknown);
  }

  if (model.xai) {
    body.image = references[0];
    if (references.length > 1) body.images = references;
  } else {
    body.input_references = references;
  }
  const url = joinUrl(env.baseUrl, openrouter ? "/images" : "/images/edits");
  try {
    const { payload } = await postJson(env, url, body);
    return parseImagesApiPayload(payload);
  } catch (error) {
    if ((error as { status?: unknown }).status !== 404) throw error;
    const { payload } = await postJson(env, joinUrl(env.baseUrl, "/images/generations"), body);
    return parseImagesApiPayload(payload);
  }
};

const requestResponses = async (env: RequestEnv, model: ImageModelRef, options: CallOptions): Promise<InlineImage[]> => {
  const content: Record<string, unknown>[] = [{ type: "input_text", text: options.prompt }];
  for (const image of options.inputImages) {
    content.push({ type: "input_image", image_url: dataUrl(image) });
  }
  const body: Record<string, unknown> = {
    model: model.id,
    input: [{ role: "user", content }],
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
    store: false,
  };
  const url = model.codex
    ? joinUrl(env.baseUrl, "/codex/responses")
    : joinUrl(env.baseUrl, "/responses");
  if (model.codex) body.stream = true;
  const { payload } = await postJson(env, url, body, model.codex ? { Accept: "text/event-stream" } : {});
  const status = (payload as { status?: unknown } | null)?.status;
  const images = parseResponsesPayload(payload);
  if (images.length === 0 && status === "failed") {
    const error = (payload as { error?: unknown } | null)?.error;
    throw new Error(
      `responses backend reported status=failed${error ? `: ${JSON.stringify(error).slice(0, 200)}` : ""}`,
    );
  }
  return images;
};

const requestChat = async (env: RequestEnv, model: ImageModelRef, options: CallOptions): Promise<InlineImage[]> => {
  const content: Record<string, unknown>[] = [{ type: "text", text: options.prompt }];
  for (const image of options.inputImages) {
    content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
  }
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [{ role: "user", content }],
    modalities: ["image", "text"],
  };
  const { payload } = await postJson(env, joinUrl(env.baseUrl, "/chat/completions"), body);
  return parseChatPayload(payload);
};

const requestGemini = async (env: RequestEnv, model: ImageModelRef, options: CallOptions): Promise<InlineImage[]> => {
  const parts: Record<string, unknown>[] = [{ text: options.prompt }];
  for (const image of options.inputImages) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  const imageConfig: Record<string, unknown> = {};
  if (options.aspectRatio !== undefined) imageConfig.aspectRatio = options.aspectRatio;
  if (options.size !== undefined) imageConfig.imageSize = options.size;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      candidateCount: 1,
      ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
    },
  };
  const base = env.baseUrl.replace(/\/+$/, "");
  const root = /\/v1beta\d*$/.test(base) ? base : `${base}/v1beta`;
  const { payload } = await postJson(env, `${root}/models/${model.id}:generateContent`, body);
  return parseGeminiPayload(payload);
};

const geminiHeaders = (apiKey: string): Record<string, string> => ({ "x-goog-api-key": apiKey });

const callDialect = (
  dialect: FabricImageDialect,
  env: RequestEnv,
  model: ImageModelRef,
  options: CallOptions,
): Promise<InlineImage[]> => {
  switch (dialect) {
    case "images":
      return requestImages(env, model, options);
    case "responses":
      return requestResponses(env, model, options);
    case "chat":
      return requestChat(env, model, options);
    case "gemini":
      return requestGemini(env, model, options);
  }
};

const readSourceImage = async (source: string, cwd: string): Promise<InlineImage> => {
  if (source.startsWith("data:")) {
    const decoded = decodeImage(source);
    if (!decoded) throw new Error(`image source is not a usable data URL: ${source.slice(0, 40)}`);
    return decoded;
  }
  const resolved = path.isAbsolute(source) ? source : path.resolve(cwd, source);
  const bytes = await readFile(resolved);
  const mimeType = mimeFromMagic(bytes);
  if (!mimeType) throw new Error(`unsupported or missing image file: ${resolved}`);
  return { data: bytes.toString("base64"), mimeType };
};

const transient = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500 || status === 408 || status === 409 || status === 429;
  return true;
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ImageProvider implements FabricProvider {
  readonly name = "image";
  readonly description = "Image generation and editing across a configurable priority chain of image models";

  constructor(
    private readonly config: () => FabricImageConfig,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => number;
      registry?: ImageModelRegistry;
      getSessionId?: () => string | undefined;
    } = {},
  ) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    if (!query) return descriptors;
    return descriptors.filter((descriptor) =>
      `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
    );
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "generate":
        return this.run("generate", args, context);
      case "edit":
        return this.run("edit", args, context);
      case "models":
        return this.chain(context);
      default:
        throw new Error(`Unknown image action: ${actionName}`);
    }
  }

  private registry(context: FabricInvocationContext): ImageModelRegistry {
    const injected = this.options.registry;
    if (injected) return injected;
    const registry = (context.extensionContext as unknown as { modelRegistry?: ImageModelRegistry }).modelRegistry;
    if (!registry) throw new Error("image provider needs a model registry on the extension context");
    return registry;
  }

  private sessionId(context: FabricInvocationContext): string | undefined {
    const injected = this.options.getSessionId;
    if (injected) return injected();
    return context.extensionContext?.sessionManager?.getSessionId?.() ?? undefined;
  }

  private resolveModel(registry: ImageModelRegistry, selector: string): ImageModelRef | undefined {
    const parsed = splitModelSelector(selector);
    if (!parsed) return undefined;
    const found = registry.find(parsed.provider, parsed.id);
    if (!isRecord(found)) return undefined;
    const api = typeof found.api === "string" ? found.api : "";
    const baseUrl = typeof found.baseUrl === "string" ? found.baseUrl : "";
    if (api.length === 0 || baseUrl.length === 0) return undefined;
    return {
      provider: parsed.provider,
      id: parsed.id,
      api,
      baseUrl,
      gptImage: GPT_IMAGE_FAMILY.test(parsed.id),
      codex: api === "openai-codex-responses",
      xai: parsed.provider === "xai" || parsed.provider === "xai-oauth" || parsed.provider.startsWith("xai-"),
    };
  }

  private dialectFor(model: ImageModelRef): FabricImageDialect {
    const override = this.config().dialects[`${model.provider}/${model.id}`];
    return override ?? inferImageDialect(model.api, model.id);
  }

  private chainSelectors(args: Record<string, unknown>): string[] {
    const preferred = typeof args.model === "string" ? args.model.trim() : "";
    const configured = this.config().models;
    const selectors = preferred.length > 0 ? [preferred, ...configured] : [...configured];
    const seen = new Set<string>();
    return selectors.filter((selector) => {
      if (seen.has(selector)) return false;
      seen.add(selector);
      return true;
    });
  }

  private async chain(context: FabricInvocationContext): Promise<unknown> {
    const registry = this.registry(context);
    const sessionId = this.sessionId(context);
    const entries: Record<string, unknown>[] = [];
    for (const selector of this.config().models) {
      const model = this.resolveModel(registry, selector);
      if (!model) {
        entries.push({ selector, resolved: false, reason: "no matching model in the registry" });
        continue;
      }
      let credentials = false;
      try {
        const apiKey = await registry.getApiKey(model, sessionId);
        credentials = typeof apiKey === "string" && apiKey.length > 0;
      } catch {
        credentials = false;
      }
      entries.push({
        selector,
        resolved: true,
        provider: model.provider,
        id: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
        dialect: this.dialectFor(model),
        credentials,
      });
    }
    return {
      enabled: this.config().enabled,
      timeoutMs: this.config().timeoutMs,
      retries: this.config().retries,
      outputDir: this.config().outputDir || os.tmpdir(),
      models: entries,
    };
  }

  private async run(
    action: "generate" | "edit",
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const config = this.config();
    if (!config.enabled) {
      return { ok: false, reason: "image provider is disabled (image.enabled=false)" };
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (prompt.length === 0) return { ok: false, reason: "prompt must be a non-empty string" };
    const selectors = this.chainSelectors(args);
    if (selectors.length === 0) {
      return { ok: false, reason: "no image models configured (image.models is empty)" };
    }
    const count =
      typeof args.count === "number" && Number.isFinite(args.count) && args.count > 0
        ? Math.min(Math.floor(args.count), 4)
        : 1;
    const aspectRatio = typeof args.aspectRatio === "string" ? args.aspectRatio : undefined;
    const size = typeof args.size === "string" ? args.size : undefined;
    const saveTo =
      typeof args.saveTo === "string" && args.saveTo.trim().length > 0 ? args.saveTo.trim() : undefined;
    const sources =
      action === "edit"
        ? Array.isArray(args.images)
          ? args.images.filter((entry): entry is string => typeof entry === "string")
          : []
        : [];
    if (action === "edit" && sources.length === 0) {
      return { ok: false, reason: "edit needs at least one image path or data URL" };
    }
    let inputImages: InlineImage[] = [];
    try {
      inputImages = await Promise.all(sources.map((source) => readSourceImage(source, context.cwd)));
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }

    const registry = this.registry(context);
    const sessionId = this.sessionId(context);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const now = this.options.now ?? Date.now;
    const started = now();
    const failures: ImageAttempt[] = [];
    const attemptsPerModel = Math.max(1, Math.min(config.retries + 1, 5));

    for (const selector of selectors) {
      const model = this.resolveModel(registry, selector);
      if (!model) {
        failures.push({ model: selector, dialect: "images", error: "no matching model in the registry" });
        continue;
      }
      const dialect = this.dialectFor(model);
      let apiKey: string | undefined;
      let extraHeaders: Record<string, string> = {};
      try {
        apiKey = await registry.getApiKey(model, sessionId);
        extraHeaders = (await registry.resolveModelHeaders?.(model, context.signal)) ?? {};
      } catch (error) {
        failures.push({ model: selector, dialect, error: `credential lookup failed: ${describeError(error)}` });
        continue;
      }
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        failures.push({ model: selector, dialect, error: "no credential for this model" });
        continue;
      }
      const authHeaders =
        model.api === "google-generative-ai" ? geminiHeaders(apiKey) : { Authorization: `Bearer ${apiKey}` };
      for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
        context.signal?.throwIfAborted();
        const signals = [AbortSignal.timeout(config.timeoutMs)];
        if (context.signal) signals.push(context.signal);
        const env: RequestEnv = {
          baseUrl: model.baseUrl,
          apiKey,
          headers: { ...authHeaders, ...extraHeaders },
          signal: AbortSignal.any(signals),
          fetchImpl,
        };
        try {
          const images = await callDialect(dialect, env, model, {
            prompt,
            aspectRatio,
            size,
            count,
            inputImages,
            signal: env.signal,
          });
          if (images.length === 0) throw new Error("backend returned no image data");
          let written: Array<{ path: string; bytes: number; mimeType: string; data: string }>;
          try {
            written = await this.write(images, saveTo, context.cwd);
          } catch (error) {
            return {
              ok: false,
              reason: `${model.provider}/${model.id} returned ${images.length} image(s) but the write failed: ${describeError(error)}`,
              model: `${model.provider}/${model.id}`,
              dialect,
              failures,
              elapsedMs: Math.max(0, now() - started),
            };
          }
          context.attachMedia?.(
            written.map((entry) => ({ type: "image" as const, data: entry.data, mimeType: entry.mimeType })),
            `Generated ${written.length} image(s) with ${model.provider}/${model.id} (${dialect}):\n${written
              .map((entry) => `  ${entry.path} (${entry.bytes} bytes)`)
              .join("\n")}`,
          );
          return {
            ok: true,
            model: `${model.provider}/${model.id}`,
            dialect,
            images: written.map((entry) => ({ path: entry.path, bytes: entry.bytes, mimeType: entry.mimeType })),
            attempts: attempt,
            elapsedMs: Math.max(0, now() - started),
            failures,
          };
        } catch (error) {
          const status = (error as { status?: unknown } | null)?.status;
          failures.push({
            model: `${model.provider}/${model.id}`,
            dialect,
            error: describeError(error),
            ...(typeof status === "number" ? { status } : {}),
          });
          if (context.signal?.aborted) throw error;
          if (attempt < attemptsPerModel && transient(error)) continue;
          break;
        }
      }
    }

    return {
      ok: false,
      reason: `every configured image model failed (${failures.length} attempt${failures.length === 1 ? "" : "s"})`,
      failures,
      elapsedMs: Math.max(0, now() - started),
    };
  }

  private async write(
    images: InlineImage[],
    saveTo: string | undefined,
    cwd: string,
  ): Promise<Array<{ path: string; bytes: number; mimeType: string; data: string }>> {
    const configured = this.config().outputDir;
    const directory =
      configured.length > 0
        ? path.isAbsolute(configured)
          ? configured
          : path.resolve(cwd, configured)
        : os.tmpdir();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const written: Array<{ path: string; bytes: number; mimeType: string; data: string }> = [];
    for (const [index, image] of images.entries()) {
      const extension = extensionForMime(image.mimeType);
      const target =
        saveTo !== undefined && images.length === 1
          ? path.isAbsolute(saveTo)
            ? saveTo
            : path.resolve(cwd, saveTo)
          : path.join(directory, `fabric-image-${Date.now()}-${index}.${extension}`);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(image.data, "base64");
      await writeFile(target, bytes, { mode: 0o600 });
      written.push({ path: target, bytes: bytes.length, mimeType: image.mimeType, data: image.data });
    }
    return written;
  }
}
