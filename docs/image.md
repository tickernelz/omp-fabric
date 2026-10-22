# Image

Fabric generates and edits images through a priority chain of models you configure. The chain is ordered, so the first entry that returns bytes wins and the result names the model that produced them.

```ts
const made = await image.generate("a red circle on a white background");
if (made.ok) {
  made.images?.[0]?.path;
  made.model;
  made.dialect;
}
```

Written files stay on disk, and the image is attached to the `fabric_exec` result, so a vision-capable model receives the pixels and the terminal shows the preview.

## Actions

| Action | Shape | Returns |
| --- | --- | --- |
| `image.generate` | `(prompt, options?)` or `({ prompt, ...options })` | `{ ok: true, model, dialect, images, attempts, elapsedMs, requestedSize?, sizeHonoured?, ignored?, failures }` |
| `image.edit` | `(prompt, images, options?)` or `({ prompt, images, ...options })` | the same shape, with the edited images |
| `image.models` | `()` | the resolved chain with dialect and credential state, no network call |

`options` accepts `model` (try this entry first), `aspectRatio`, `size` (`1024x1024`, `1536x1024`, `1024x1536`), `count` (images API only, capped at 4), and `saveTo` (file path for a single image).

`aspectRatio` and `size` reach the backend only where the wire has a field for them. The `images` dialect sends `size`/`aspect_ratio`, `gemini` sends `imageConfig`, and `responses` maps the ratio onto the image tool's `size` (`1:1` becomes `1024x1024`, `16:9` becomes `1536x1024`). The hosted image tool accepts three pixel sizes only, so a `16:9` request is approximated to `1536x1024`, which is 3:2: `requestedSize` reports the resolved pixel size, never the ratio you asked for. The `chat` dialect has neither field, so a successful call through it reports `ignored: ["aspectRatio", "size"]` and never implies the request was honoured. An unrecognised ratio on `responses` is reported the same way. `count` is honoured by the `images` dialect alone, so asking for more than one image anywhere else reports `count`, and a `saveTo` that cannot apply because several images came back reports `saveTo`.

Each entry in `images` carries the pixel `width` and `height` read from the file header, and a call that asked for a size reports the `requestedSize` it resolved. When the backend returns something else, the result carries `sizeHonoured: false`. `ignored` covers parameters the wire cannot carry; `sizeHonoured` covers a parameter that was sent and then not obeyed, which is a different failure and a gateway can produce it.

An operational failure never throws. `image.generate` answers `{ ok: false, reason, failures }` so a caller can read which model failed and why:

```ts
const made = await image.generate("a logo mark");
if (!made.ok) {
  made.failures?.map((failure) => `${failure.model} ${failure.dialect} ${failure.status ?? ""} ${failure.error}`);
}
```

## Dialects

Each model speaks one wire shape. The dialect comes from the model's `api` unless `image.dialects` overrides it.

| Dialect | Wire | Chosen when |
| --- | --- | --- |
| `images` | `POST /images/generations`, `POST /images/edits`; `openrouter-images` posts to `POST /images` instead, and `openai` sends edits as multipart | `api` is `openai-images` or `openrouter-images`, or a `*-responses` model whose id looks like an image model |
| `responses` | `POST /responses` with the `image_generation` tool and `tool_choice`; `openai-codex-responses` posts to `/codex/responses` and reads the event stream | a `*-responses` chat model, which relays through the hosted tool |
| `chat` | `POST /chat/completions` with `modalities: ["image", "text"]` | any other `api`, including `google-gemini-cli`, reading the reply from `message.images` or from a data URL in the content |
| `gemini` | `POST /v1beta/models/{id}:generateContent` with `x-goog-api-key` | `api` is `google-generative-ai` |

Dialect is per model, not per provider: one gateway can serve image bytes through a chat endpoint under one key and through the images API under another. `google-generative-ai` authenticates with `x-goog-api-key`; every other dialect uses a bearer token. A `gpt-image` model omits `response_format`, because those models reject it.

Every dialect carries reference images in its own shape: `input_references` for a JSON gateway, multipart `image` parts for `openai`, `image`/`images` for xAI, `image_url` parts for chat, `input_image` for responses, and `inlineData` for gemini. A backend that refuses the reference answers with its own error, which lands in `failures` and the chain continues.

## Priority chain

The chain is `image.models`, an ordered list of up to 10 `provider/model` entries, edited under `/fabric settings` → **Image** → **Priority N**. An empty priority is skipped, so removing an entry compacts the rest upward.

A selector keeps every slash after the provider, so `xai-hm/antigravity/gemini-3.1-flash-image` resolves the provider `xai-hm` and the model id `antigravity/gemini-3.1-flash-image`.

`image.retries` re-attempts one model after a transient failure (5xx, 408, 409, 429, or a network error) before the chain moves on. Hosted image calls drop often enough that a retry changes the success rate measurably.

## Configuration

- `image.enabled` (default `true`) exposes the `image.*` actions. With it off the provider is not registered and the `image` guest global is removed.
- `image.models` (default empty) is the ordered chain, capped at 10 entries. Duplicates and entries without a slash are dropped on load.
- `image.dialects` (default empty) overrides the inferred dialect per `provider/model`. File-only, because it is a per-gateway escape hatch.
- `image.timeoutMs` (5000-900000, default 60000) bounds one model attempt, including the body read. The whole attempt budget has to fit inside `executor.timeoutMs`, which bounds the program: the defaults of one 60 s attempt with one retry come to 120 s, exactly the executor default. Raise both together, or a slow gateway is cancelled by the program deadline before the attempt reports `{ ok: false }`.
- `image.retries` (0-4, default 1) is the extra attempts per model after a transient failure.
- `image.outputDir` (default empty) is where files are written. Empty uses the OS temp directory.

## Measured on one workstation

Three models were probed against live gateways while this provider was built. Numbers come from those runs, not from vendor documentation.

| Entry | Dialect | Result |
| --- | --- | --- |
| `xai-hm/antigravity/gemini-3.1-flash-image` | `images` | 3 of 3 calls returned a JPEG, 412 KB to 541 KB |
| `sub2api-agy/gemini-3.1-flash-image` | `chat` | 3 of 3 calls returned a JPEG through a data URL, 464 KB to 698 KB |
| `xai-hm/cx/gpt-6.1-sol` | `responses` | 1 of 3 calls returned a PNG, about 1 MB; the rest reported `status=failed` |

A `responses` entry needs a retry budget, because the hosted tool fails without an error body on some calls. An `images` entry is the steadier default when one is available.

Edits were measured too. `image.edit` through the `responses` dialect recolored a 470 KB source JPEG and returned a 1.5 MB PNG on the first attempt. The same gateway refused an `images`-dialect edit of the same file with `400 Missing required field: image`, and that refusal reached `failures` without stopping the chain, which is the behaviour the contract promises.
