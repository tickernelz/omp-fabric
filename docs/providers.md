# External providers

Fabric [captures normal `omp.registerTool()` tools automatically](configuration.md#captured-extension-tools). Extensions use the versioned provider protocol for non-tool capabilities or virtual action catalogs with risk data.

Fabric mounts each non-kernel first-party provider through a pinned component. External providers can use direct registration with a host-owned lifetime. A provider that belongs to a supervised external component calls `context.provide()` for staged publication and rolling replacement. The same component link controls dependency withdrawal.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "omp-fabric/protocol";

export default function extension(omp: ExtensionAPI) {
  const provider: FabricProvider = {
    name: "example",
    description: "Example actions",
    async list() {
      return [];
    },
    async describe() {
      return undefined;
    },
    async invoke() {
      return null;
    },
  };

  omp.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
    version: 1,
    provider,
    overwrite: true,
  });

  omp.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: FabricProviderDiscovery) => {
    event.register(provider, { overwrite: true });
  });
}
```

Each provider owns its schemas, its state, and how its actions execute. OMP Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation. A provider can also enrich the generic [activity surface](interface.md#data-driven-activity) without registering a TUI component:

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Effect semantics and scoped acquisition

Action descriptors can declare effect semantics. Descriptor hashes and committed component and actor views carry this metadata. Omitting it is the conservative choice. Read-risk actions then resolve as commutative `none`, and every other risk resolves as unknown-order `emission`.

Actions with `kind: "scoped"` must implement `provider.acquire()` and return `{ value, dispose }`. Components call these actions through `context.acquire()`. That path validates arguments, pins the provider generation, and registers a single-shot disposer in the component scope. Ordinary `invoke()` stays available for `none`, `transactional`, and `emission` actions. A component that declares the `revertible` guarantee can normally call only `none` and `transactional` actions. Fabric rejects emissions from it.

The `resources` field names the affected resource classes, and `ordering` is `commutative`, `ordered`, or `unknown`. Fabric records concurrent non-read calls with an unknown footprint, along with overlapping non-commutative resources, in `audits[].effectConflicts`. Revertible components reject those calls. Fabric never reorders calls based on provider claims. These fields carry scheduling and lifecycle semantics. They do not replace authorization, and `risk` continues to drive approval policy. Providers whose descriptors can change in place may implement `subscribeCatalog(listener)`. Fabric then re-resolves dependent component targets and unsubscribes when that provider generation closes. See [components and committed capabilities](components.md).

## Nested `tool_result` proxy

Results from MCP, agent, memory, state, schema, mesh, components, compact, and external providers pass through OMP's `tool_result` middleware before Fabric enforces `maxNestedResultChars`. A user extension can then externalize or replace an oversized provider result before that result crosses into QuickJS.

A proxied event carries:

- `toolName` holding the fully qualified Fabric ref, such as `mcp.github.search`;
- a `toolCallId` that starts with `FABRIC_NESTED_TOOL_CALL_ID_PREFIX`;
- text `content` holding the raw string result or a JSON projection;
- `details` matching `FabricToolResultProxyDetailsV1`, whose `result` is the exact host-side structured value.

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  readFabricToolResultProxyDetailsV1,
} from "omp-fabric/protocol";

export default function resultGuard(omp: ExtensionAPI) {
  omp.on("tool_result", async (event) => {
    if (!event.toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX)) return;
    const proxy = readFabricToolResultProxyDetailsV1(event.details);
    if (!proxy || proxy.ref !== event.toolName) return;

    const serialized =
      typeof proxy.result === "string"
        ? proxy.result
        : (JSON.stringify(proxy.result) ?? String(proxy.result));
    if (serialized.length <= 6_144) return;

    const artifact = await persistPrivately(serialized);
    const replacement = {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: `${serialized.slice(0, 3_000)}\n…`,
      artifact,
    };
    return {
      content: [{ type: "text", text: replacement.preview }],
      details: { ...proxy, result: replacement },
    };
  });
}
```

If you change only `content`, the nested sandbox value becomes the patched text. To keep a structured replacement, return the proxy envelope in `details` with a changed `result`, as in the example above. When both fields are patched, a valid changed `details.result` takes precedence. Returning `isError: true` fails the nested provider invocation.

OMP core tools and captured extension tools skip this generic proxy, because they already replay their native `tool_call`, `tool_result`, and `tool_execution_*` lifecycle. Nested shell calls still emit their native identity: `omp.bash()` uses `toolName: "bash"`/`isBashToolResult()`. Proxied events act as middleware only. They create no separate persisted tool-result messages.
