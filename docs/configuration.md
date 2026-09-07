# Configuration

OMP Fabric reads configuration from two JSON files. Project values override global values.

1. `<active OMP agent dir>/fabric.json`: global defaults.
2. `<project>/.omp/fabric.json`: project overrides, only for **trusted** projects.

`/fabric settings` opens at global scope in every session. In a trusted project, press **Ctrl+G** anywhere in the settings view to move both the displayed values and the save destination between the global `<active OMP agent dir>/fabric.json` and `<project>/.omp/fabric.json`; project overrides are an explicit opt-in. The global view shows global defaults even when a project override stays effective in the current session, and the scope banner marks that precedence. Both views show persisted values. The affected setting notes when a runtime-only environment override still controls the live session. Untrusted sessions remain global-only. RPC hosts expose the same nested settings through standard select/input dialogs and provide a root save-scope action, so no terminal keybinding is required.

`configVersion` versions each configuration document. Fabric migrates each applicable file independently before it applies global/project precedence, then rewrites migrated files atomically. Version 0, the historical unversioned format, renames `subagents` to `agents`. Versions 2 and 3 rename legacy UI settings. Version 4 repairs `prewalk.enabled` string booleans emitted by the settings UI in affected builds. When both legacy and canonical sections exist, canonical values win conflicts and non-conflicting values survive. Fabric migrates trusted project files, and it never reads or rewrites untrusted project files. Add future schema changes as sequential migrations. Avoid runtime aliases.

`executor.runtime` selects `"quickjs"` (the default isolated WASM runtime), `"node-process"` (a disposable native V8 process), or `"bun-process"` (a disposable native Bun/JavaScriptCore process). QuickJS memory limits stop at `4294967295` bytes, because its WASM32 `size_t` cannot represent 4 GiB. Fabric rejects larger values. It never wraps them. Node process limits can reach the detected physical memory, and Fabric passes them to V8 as `--max-old-space-size`. Bun process limits reach the same ceiling, but Bun ignores V8 heap flags, so the value is advisory, never an enforced cap.

Treat `node-process` and `bun-process` as an explicit escape hatch for trusted code. It offers no security sandbox. The runtime keeps Fabric's IPC host bridge, approvals, audit records, timeout, and cancellation in place. Node's and Bun's `vm` APIs provide no security boundary. Enable it only for workloads and projects whose generated code you accept running with the local user account's authority. Each invocation starts a fresh child process, and Fabric forcibly terminates that process when it settles, times out, or is cancelled. Schema enforce mode always forces `quickjs`. Large limits in either runtime can exhaust system memory or destabilize the machine.

### Executor timeouts and ceilings

`executor.timeoutMs` (default `120000`) bounds a whole `fabric_exec` program. Two mechanisms can raise it:

- **Per-invocation request**: `fabric_exec({ timeoutMs: 600000, code: ... })` asks for a longer whole-program deadline for that one call. It can never reduce the default: the effective timeout is `max(executor.timeoutMs, requested)`.
- **Per-ref floor**: `executor.hostCallTimeouts` maps exact host-call refs (no wildcards) to a minimum deadline in ms. A matching ref raises the enclosing deadline to at least the configured value without any tool-side timeout argument:

```json
{
  "executor": {
    "timeoutMs": 120000,
    "maxTimeoutMs": 3600000,
    "hostCallTimeouts": {
      "extensions.subagent": 3600000
    }
  }
}
```

Every raised deadline is capped by `executor.maxTimeoutMs` (default `900000`, i.e. 15 minutes: the former undocumented clamp, now explicit), which itself can be raised up to the hard implementation maximum of 24 hours. Values above a cap are visibly normalized down to the cap during config load and the effective values are shown in `/fabric` settings, never silently surprising. A per-invocation request or ref floor takes effect even when the ref is unknown to Fabric, so captured tools, MCP calls, and future host calls all run within an intentionally longer deadline without Fabric knowing their argument semantics. Existing `omp.bash` behavior (extending the deadline from an explicit `timeout` argument) is unchanged, and deadline expiry still cancels the active host call and any child process it owns.

The precedence across all sources is:

```text
effective timeout = min(
  maxTimeoutMs,
  max(executor.timeoutMs, matching hostCallTimeouts[ref], fabric_exec.timeoutMs)
)
```

where absent values do not participate. Orchestration programs (`agents.run` / `agents.wait` / `agents.ask`, `workflow.agent`, ...) keep their separate `agents.timeoutMs` floor, which is unaffected by `executor.maxTimeoutMs`.

## Full reference

```json
{
  "configVersion": 4,
  "fullCodeMode": true,
  "executor": {
    "runtime": "quickjs",
    "timeoutMs": 120000,
    "maxTimeoutMs": 900000,
    "hostCallTimeouts": {},
    "memoryLimitBytes": 268435456,
    "maxOutputChars": 100000,
    "maxNestedResultChars": 2000000,
    "resultFormat": "auto"
  },
  "approvals": {
    "read": "allow",
    "write": "allow",
    "execute": "allow",
    "network": "allow",
    "agent": "allow"
  },
  "capture": {
    "enabled": false,
    "hideFromModel": false,
    "keepVisible": ["fabric_exec"],
    "includeTools": [],
    "excludeTools": [],
    "defaultRisk": "execute",
    "risks": {
      "read": "read",
      "grep": "read",
      "find": "read",
      "ls": "read",
      "edit": "write",
      "write": "write",
      "bash": "execute",
      "fovea_sketch": "read",
      "fovea_focus": "read",
      "fovea_dwell": "read",
      "fovea_impact": "read"
    }
  },
  "mcp": {
    "enabled": true,
    "disableOAuth": true,
    "allowDynamicServers": true,
    "callTimeoutMs": 90000,
    "cache": {
      "enabled": true,
      "revalidate": "changed",
      "revalidateBudgetMs": 60000
    }
  },
  "prewalk": {
    "enabled": true,
    "mode": "in-place",
    "alwaysRearm": false,
    "detectShellWrites": true
  },
  "models": {
    "aliases": {
      "cheap": "google/gemini-2.5-flash",
      "budget": ["openai/gpt-5-mini", "google/gemini-2.5-flash"]
    }
  },
  "agents": {
    "enabled": true,
    "runner": "omp",
    "transport": "process",
    "claude": {
      "binary": "claude"
    },
    "veda": {
      "binary": "veda",
      "backend": "agy",
      "persona": "navigator-chat"
    },
    "thinking": "medium",
    "maxConcurrent": 8,
    "maxPerExecution": 100,
    "maxDepth": 3,
    "timeoutMs": 3600000,
    "extensions": true,
    "defaultTools": ["read", "bash", "edit", "write", "grep", "find"],
    "retainRuns": false,
    "notifyOnComplete": true,
    "budgetUsd": 0,
    "maxTokensPerChild": 0,
    "sessionExport": true,
    "sessionExportDir": ""
  },
  "components": [
    {
      "id": "project-service",
      "component": "registered-definition",
      "config": {},
      "disabled": false
    }
  ],
  "ui": {
    "enabled": true,
    "widget": "auto",
    "maxRows": 10,
    "refreshMs": 500,
    "eventHistory": 80,
    "haltOnEscape": true,
    "showAgentToolPreview": true,
    "toolDisplay": "compact",
    "updateDebounceMs": 100
  },
  "compaction": {
    "engine": "fabric"
  },
  "retention": {
    "orphanedTempRunMs": 21600000,
    "oneShotRunMs": 86400000,
    "actorRunArchiveMs": 604800000
  },
  "mesh": {
    "enabled": true,
    "actorScope": "project",
    "maxEventBytes": 262144,
    "maxReadEvents": 500,
    "actorPollMs": 250,
    "actorQueueLimit": 32,
    "eventContextChars": 40000
  }
}
```

## Components

`components` is a root array of declarative supervised instances. Each `id` gives one instance a stable identity, and `component` names its definition in the versioned protocol. Fabric passes `config` to `activate(context, config)`. The `disabled` field removes an instance from the active graph and preserves its declaration. An empty array is the default, with a limit of 256 valid entries. The runtime installs enabled first-party providers as pinned `fabric.provider.*` components whose reserved IDs sit outside this array.

Unknown definitions stay visible as waiting. They do not fail the Fabric runtime. Late discovery activates them. `/fabric reload` reconciles entry changes as a transaction. When a definition re-registers with `overwrite: true`, Fabric uses the same rollback-capable replacement path. See [components, effects, and committed capabilities](components.md).

## Speculation

`speculation` configures opportunistic pre-launch of read-class calls while the model streams a `fabric_exec` program; see [speculative PTC](speculation.md) for the correctness contract. `speculation.enabled` (default `true`) masters the feature. `speculation.maxConcurrent` (1-32, default 4) caps in-flight speculative calls. `speculation.maxEntries` (1-1024, default 64) bounds retained unserved entries per turn. `speculation.maxBufferBytes` (64 KiB-64 MiB, default 2 MiB) caps the per-stream partial-argument buffer. `speculation.entryTtlMs` (5 s-30 min, default 180000) expires unserved entries. `speculation.mcpAllowlist` (default empty) enables Tier-B speculation of read-only MCP tools with `server.tool` or `server.*` patterns.

## Prewalk executor

`prewalk.enabled` defaults to `true` and is the persistent master switch. Turn it off under **Prewalk → Enabled** in `/fabric settings`, or run `/fabric prewalk --disable`; the command always saves to global scope, and the settings view saves to whichever scope it currently targets. Disabling also cancels any live arm. `/fabric prewalk --enable` turns it back on. `/fabric prewalk --off` only cancels the current arm for this session and does not change the saved master switch.

`prewalk.model` is the optional OMP `provider/model` that `/fabric prewalk` selects. `prewalk.mode` chooses how execution continues:

- `"in-place"` (default) switches Main to the executor model, queues a hidden follow-up in the same session, and restores Main's boundary model when the continuation settles.
- `"trajectory"` forks the finalized outer Fabric call and result to a visible OMP child, then waits for it. After the child finishes, a hidden continuation asks Main to verify the work and report its findings.

```json
{
  "prewalk": {
    "enabled": true,
    "mode": "in-place",
    "model": "anthropic/claude-haiku-4-5",
    "thinking": "high",
    "alwaysRearm": true,
    "compactOnReturn": true
  }
}
```

`prewalk.thinking` sets the optional reasoning effort for the trajectory child executor. Its values are `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`, clamped to each model's supported levels. When you leave it unset, the executor inherits `agents.thinking`. In-place mode keeps Main's session level.

`prewalk.alwaysRearm` defaults to `false`. When enabled, prewalk returns to an armed, taskless state after each completed handoff (in-place return or trajectory completion). Every session then starts armed automatically, non-interactively from `prewalk.model`, and `/fabric reload` re-arms as well. `/fabric prewalk --off` cancels the armed state until the next session start or reload. Turns that settle without a handoff never disarm prewalk, regardless of this setting. The settings UI labels an unset model **Ask each time**. Non-interactive sessions must configure a model. In-place mode does not require child agents. Trajectory mode requires `agents.enabled`. It shows child spawn, progress, nested tools, metrics, and completion in Main's Fabric activity UI.

`prewalk.detectShellWrites` defaults to `true`. When armed, a `fabric_exec` boundary that ran a successful `omp.bash` without an audited `omp.edit` / `omp.write` / `schema.commit` claims the handoff if file size or mtime stats drifted from the arm-time baseline. This routes shell heredocs and formatter binaries to the executor as well. The report's `trigger.files` lists the bounded drifted paths. Set it to `false` to accept audited mutations only.

`prewalk.compactOnReturn` defaults to `true`. When an in-place continuation settles, Fabric requests a compaction with the configured `compaction.engine` and commits it while the executor is still the active model. Main's restored model receives the compacted transcript. Set this option to `false` when Main must receive the complete transcript.

Each in-place handoff captures Main's active model at the boundary and restores it when the continuation settles. OMP's public `setModel` extension API also updates OMP's default model setting, so the restore returns the configured default to Main's model as well. A session that ends mid-continuation keeps the executor selection persisted until the next settle.

## Models

`models.aliases` names model selectors for `agents.switchModel` and for OMP-runner `model` arguments on `agents.run`, `agents.spawn`, `agents.create`, and `agents.handoff` (see [Agents](agents.md#switching-mains-session-model)). Each alias is either one `provider/model` target or an ordered fallback chain; resolution walks the chain and uses the first authenticated target. Alias names match case-insensitively and take priority over bare model ids and fuzzy matching. Aliases live in normal Fabric configuration, so a project `.omp/fabric.json` can extend the agent-level `fabric.json`; entries with malformed names or targets are ignored at load.

```json
{
  "models": {
    "aliases": {
      "cheap": "google/gemini-2.5-flash",
      "budget": ["openai/gpt-5-mini", "google/gemini-2.5-flash"]
    }
  }
}
```

## Result formatting

`executor.resultFormat` sets the default for `fabric_exec` return values. Find it under `/fabric settings` → **Executor**. `"auto"` keeps strings as text and renders structured values as syntax-highlighted YAML. `"yaml"`, `"json"`, and `"text"` each force their named behavior. A call-level `resultFormat` parameter overrides the configured default.

Configure the compaction engine under `/fabric settings` → **Compaction**. Select `"fabric"` for deterministic compaction or `"omp"` to hand compaction to OMP core.

## Code modes

In the default full code mode, `fabric_exec` owns OMP core tool execution. The parent model sees one programmable tool. The direct `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` schemas stay hidden. Fabric programs reach those capabilities through `omp.*`:

```ts
const files = await omp.find({ pattern: "**/*.ts", path: "src" });
const matches = await omp.grep({ pattern: "TODO", path: "src" });
return { files, matches };
```

Run independent calls in parallel:

```ts
const [packageJson, readme] = await Promise.all([
  omp.read({ path: "package.json" }),
  omp.read({ path: "README.md" }),
]);
return {
  package: JSON.parse(packageJson).name,
  readmeLines: readme.split("\n").length,
};
```

OMP core calls reject when the native tool reports an error. Successful `bash`, `edit`, and `write` calls return the `{ ok: true, output, details }` shape. Catch a rejection when recovery is local. Shell tools reject on an ordinary nonzero exit. Pass `settle: true` (for example `omp.bash({ command, settle: true })`) to receive `{ ok: false, output, details: null, exitCode, error }` on a nonzero exit. Timeout, cancellation, approval, security, and spawn failures still reject.

### Full code mode

`fullCodeMode: true` is the default. Fabric takes OMP's native core tools out of the model-facing set and exposes their implementations through `fabric_exec`; `omp.read()` and the other `omp.*` core calls route through the host adapter.

Fabric records which native core tools were active before it takes ownership. Switching to orchestration-only mode or unloading Fabric restores that selection. Fabric applies full-mode ownership only when the session initializes or the mode changes. It never resets an explicitly selected active tool set from input, agent-start, turn-end, or settled lifecycle hooks. The system prompt carries the full-mode execution rule.

OMP core shows its model-visible skill catalog only while the native `read` tool is active. Full code mode restores the same catalog from OMP's structured skill registry and changes only the loader instruction, so `omp.read` runs inside `fabric_exec`. Native core tools stay hidden. Packaged skills mark cross-document paths with `<skill-dir>`. Fabric replaces that marker inline from OMP's expanded skill `location` or the actual `SKILL.md` read path. It never matches skill names or enumerates directories. Ordinary document reads stay unchanged. When an expanded skill invokes another installed skill, Fabric adds an exact name-to-path resolution hint for that turn, and the delegated `SKILL.md` loads before task work.

### Orchestration-only mode

Some users want Fabric for MCP, agents, ambient actors, parallel workflows, councils, and recursive delegation while OMP's core tools remain fully native. Those users can opt out of full code mode:

```json
{
  "fullCodeMode": false
}
```

In orchestration-only mode:

- OMP's `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools stay on OMP's normal model-facing and execution paths. Fabric applies the configured risk approval policy through OMP's native `tool_call` preflight, and it leaves their execution and rendering untouched.
- Registered extension tools also remain in OMP's native registry. Fabric does not hide, wrap, or expose them through `extensions.*`. Model-requested direct calls use exact `capture.risks` overrides or the conservative `capture.defaultRisk` approval class.
- `omp.*`, `extensions.*`, and equivalent `tools.call()` references are unavailable inside `fabric_exec`, even when TypeScript checks are bypassed.
- MCP and stable Fabric providers remain available through `mcp.*`, `memory.*`, `state.*`, `schema.*`, `components.*`, `compact.*`, and `codemap.*` (whose `map` and `cascade` take an optional `path` to target a directory other than the session's). Generic discovery and computed refs still work through `tools.*`. One-shot and recursive agents, persistent ambient actors, dynamic workflows, mesh coordination, councils, explicit Fabric providers, and the Fabric TUI keep their full behavior.
- Child agents continue using their allowed OMP tools directly, so parallel and ambient setups never route their coding operations back through Fabric code mode.

### Where to set `fullCodeMode`

`fullCodeMode` defaults to `true`. Set it to `false` in `.omp/fabric.json` for one project, or globally in `<active OMP agent dir>/fabric.json` for every project. `/fabric settings` toggles it as well.

### Partial results

A guest core-tool call returns the whole result, or it says that it did not. When the host cut a payload, the returned string ends with one extra line:

```text
[[omp-fabric:truncated]] {"reasons":["matchLimit"],"perFileMatchLimit":200}
```

The marker is the last line, it is emitted only for a partial result, and a complete result is byte-identical to the file or command output. Programs that parse a whole file therefore keep working, and a program that must detect a cut branches on the marker.

`omp.read` pages internally, so the host's per-call line ceiling is not visible to a program; a marker appears only where paging cannot help, such as one line larger than the byte budget. `omp.grep` and `omp.find` carry host caps that Fabric cannot lift, so they signal. `omp.bash` recovers column-truncated output from its own artifact and marks only what it could not restore.

A file the host cannot decode as text is an error, not content: `omp.read` throws with a message beginning `omp.read returned no text content:` and names the `:raw` selector that does work.

## Captured extension tools

Fabric intercepts OMP's `ExtensionRunner.getAllRegisteredTools()` registry chokepoint when capture is enabled. This captures tools that other extensions register at startup or later through the OMP extension API. OMP built-in, SDK, and MCP tools are never added to Fabric's captured-extension catalog.

Captured custom tools leave the model's active tool set by default. Their schemas, snippets, and guidelines stop consuming the parent model context, and the model reaches them only through `fabric_exec` when capture hiding is enabled. The tools stay registered in OMP's runtime, so the host tool registry keeps listing them. The owning extension remains loaded: its commands, event handlers, state, and UI continue to work.

The shipped default enables capture and hands OMP's native core tools to `fabric_exec`. This avoids a second model-facing implementation of the same read, write, shell, search, and task surfaces. Set `fullCodeMode` to `false` to keep those native tools model-facing; `fabric_exec` is then additive and adds batching and typed orchestration without replacing them.
```ts
const matches = await tools.search({ query: "deployment status" });
const schema = await tools.describe({ ref: matches[0].ref });
const result = await tools.call({
  ref: schema.ref,
  args: { environment: "staging" },
});
return result;
```

For tool names valid as JavaScript properties, use the shorter proxy:

```ts
const result = await extensions.project_status({ verbose: true });
return result.text;
```

The result keeps `content`, exposes text content as `text`, and carries `details`, `isError`, `terminate`, and source provenance. Fabric runs the captured definition's `prepareArguments()` and original executor with its owning extension context. OMP's `tool_call`, `tool_result`, and `tool_execution_*` lifecycle handlers also apply to nested captured calls.

In full code mode, Fabric captures and hides extension overrides of core tools together with their built-in counterparts. Inside Fabric, `omp.read`, `omp.bash`, and the other core calls route through the OMP adapter when an override exists. `extensions.read` exposes the override's full native result shape. `capture.keepVisible` can re-activate non-core extension tools, and `capture.includeTools` explicitly keeps selected tools visible. `capture.excludeTools` hides selected tools; excludes win over includes. In Schema enforce mode, `fabric_exec` remains the only model-facing tool.

`capture.includeTools` and `capture.excludeTools` are name lists over the current OMP registry. Include does not invent an unavailable tool. Exclude is applied after include, so a name present in both lists stays hidden. Leave both empty to preserve OMP's native active set.

## Approvals and risk


  
Native calls keep OMP's original implementation, result shape, and renderer. Fabric adds only the supported interception hook that runs before execution.

- Captured and directly registered tools default to the conservative `execute` risk because OMP tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`. Fovea's verified graph-navigation tools (`fovea_sketch`, `fovea_focus`, `fovea_dwell`, and `fovea_impact`) are read-only exceptions that default to `read`.
- Set `capture.hideFromModel` to `false` to index non-core extension tools without hiding them from the model's active set.
- Names in `capture.keepVisible` stay in the model-facing active set of both Fabric and OMP. OMP core names are the exception: they remain Fabric-owned in full code mode.
- Extension tool names appear in the prompt as a names-only roster; descriptions and schemas are resolved on demand via `tools.list` / `tools.search` / `tools.describe` before first use.
- An `ask` policy emits a warning notification and opens an explicit **Allow once** / **Allow for this session** / **Deny** permission prompt. These options match Claude-style approval scopes. **Allow once** authorizes only the requested action. **Allow for this session** keeps that risk class authorized until the current OMP session ends. The TUI uses an inline wizard. RPC clients receive the equivalent `select` dialog.
- Fabric serializes concurrent requests so a one-time approval never silently widens to sibling calls. Session-wide grants apply to native calls and to `fabric_exec`. Escape, dismissal, unavailable interactive UI, and session restart all fail closed.

### Auto approval mode

An `auto` policy sends each validated call and its prepared arguments to a separate OMP model before invocation. Configure **Auto model** under `/fabric settings` → **Approvals**, or set the optional canonical `provider/model` key in `fabric.json`:

```json
{
  "approvals": {
    "model": "anthropic/claude-opus-4-6",
    "write": "auto",
    "execute": "auto",
    "network": "auto",
    "agent": "auto"
  }
}
```

Choose **Inherit** in the model picker to omit `approvals.model` and use the active OMP session model. Built-in and custom models dispatch through OMP's effective provider runtime, including providers with custom API identifiers. Older supported OMP versions fall back to their compatibility provider registry. Read access stays independently configurable, and most setups leave it at `allow`.

The classifier receives the exact action, bounded prepared arguments, cwd, user-message text, and assistant tool calls. Fabric excludes assistant prose and tool outputs, so model-authored reasoning and retrieved hostile content cannot directly instruct the classifier. The classifier has no executable tools and must return a structured `allow` or `escalate` verdict. An `allow` verdict applies only to that call. `escalate`, malformed output, missing authentication, timeout, cancellation, or any classifier error falls back to the explicit **Allow once** / **Allow for this session** / **Deny** prompt. Headless runs fail closed when that prompt cannot be shown. Fabric attaches classifier token usage and cost to the resulting `fabric_exec` or native tool result, and execution traces record each nested verdict as `fabric.approval.auto`.

`deny` stays deterministic and runs before the classifier. Schema enforcement, project trust, budgets, and other host gates remain authoritative. Auto mode is a model-based policy advisor and provides no stronger sandbox boundary. Its initial conservative policy escalates destructive or irreversible actions, shared/external/production changes, credential or sensitive-data exposure, safety bypasses, actions beyond explicit user intent, and actions whose safety is uncertain. Fabric adapts the policy architecture described in Claude Code's [permission modes](https://code.claude.com/docs/en/permission-modes), [auto-mode configuration](https://code.claude.com/docs/en/auto-mode-config), and Anthropic's [auto-mode engineering write-up](https://www.anthropic.com/engineering/claude-code-auto-mode), adapted to OMP's model registry and Fabric's existing per-risk policy gate.

## Temporal retention

Fabric clears inactive run artifacts by age. It never truncates active JSONL files. The defaults are:

- `retention.orphanedTempRunMs`: remove a temporary run root six hours after its owner process dies. Active roots carry a heartbeat marker and are never removed.
- `retention.oneShotRunMs`: retain terminal one-shot agent run artifacts for 24 hours. An explicit `agents.cleanup()` may remove them sooner. On every other path, graceful shutdown marks their temporary root closed for temporal cleanup.
- `retention.actorRunArchiveMs`: retain terminal actor run archives for seven days. Fabric always preserves the latest run for each actor.

Cleanup runs during active Fabric sessions and when a new top-level run manager starts. It never truncates active run logs or actor `session.jsonl` files. `/fabric settings` exposes all three values under **Retention**. Changing them requires `/fabric reload`.

## Agents

`agents.runner` selects the default harness: `"omp"`, `"claude"`, or `"veda"`. `agents.model` is the optional OMP `provider/id` override. `agents.claude.model` is the optional canonical Claude runtime key. `agents.claude.binary` defaults to `claude`. You can supply an absolute path or a wrapper. `OMP_FABRIC_CLAUDE_BINARY` overrides it for the current process. `/fabric settings` enumerates Claude models from that binary in the background and stores the two runner defaults independently.

The `veda` runner drives the [Veda CLI](https://github.com/kennyfrc/veda) as the child harness. `agents.veda.binary` defaults to `veda`. An absolute path or wrapper works, and `OMP_FABRIC_VEDA_BINARY` overrides it for the current process. `agents.veda.backend` selects which backend Veda wraps: `agy` (Antigravity CLI, the default), `codex`, `claude-code`, `droid`, `pi`, or another backend registered by the installed Veda build. The `pi` value is an external Veda backend name, not an OMP host compatibility mode. Fabric passes this value through unchanged and never hardcodes AGY. `agents.veda.model` is an optional backend-specific model or Veda alias. When you omit it, Veda selects its own backend default. `agents.veda.persona` picks the global Veda persona: `navigator-plan`, `navigator-chat` (default), `reviewer`, `worker`, or a custom persona under `~/.config/veda/personas/<name>/AGENTS.md`. Per-run selection overrides it through `agents.run({ persona })`. You can also edit the Veda backend, persona, and model in the Fabric settings panel under Agents. Each child runs one headless `veda --json` prompt with an isolated `fabric-<run-id>` session, so parallel children never share Veda selection or conversation state. Veda sessions lack persistence, and steering is unsupported. Veda children are not recursively Fabric-equipped (`recursive: true` is rejected), and they cannot back persistent actors.

A JS runtime launches each Fabric worker module. Fabric reuses the current runtime when `process.execPath` names `node` or `bun`. When the current executable is a compiled OMP binary, Fabric uses `OMP_FABRIC_NODE_BINARY` or the first `node` or `bun` on `PATH`. The resolved runtime launches the workers. The Node-process executor (`executor.runtime: "node-process"`) requires Node.js because it uses `--eval` and `--input-type=module`; the Bun-process executor (`executor.runtime: "bun-process"`) requires Bun because it uses `--eval`.

Other agent settings:

- `thinking`: default reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), default `medium`.
- `maxConcurrent`: global child concurrency semaphore.
- `maxPerExecution`: hard cap on children per `fabric_exec` invocation.
- `maxDepth`: nesting bound for child agent calls, including `rlm.query()`. It accepts any non-negative safe integer. A value of `0` disables child spawning. `/fabric settings` provides free-form numeric entry.
- `timeoutMs`: default wall-clock budget per child and the floor for per-call overrides (60 minutes by default). Fabric ignores lower per-call values. Set `timeoutMs` only to request a longer run.
- `extensions`: whether Claude children keep their normal Claude Code customizations.
- `defaultTools`: the default tool allowlist for children.
- `budgetUsd`: shared append-only cost ledger across a recursion tree (0 disables).
- `maxTokensPerChild`: cumulative token bound per child (0 disables).
- `notifyOnComplete`: send a follow-up completion message for a detached `agents.spawn()`.
- `sessionExport`: export each agent run's usage as an attributed OMP-format session file (on by default).
- `sessionExportDir`: override the export store root (default `~/.omp-fabric/agent`, with `OMP_FABRIC_AGENT_DIR` taking precedence).

### Usage tracking with external tools

Fabric children run with `--no-session`, so token trackers that scrape session files (tokscale, ccusage, …) cannot see subagent token usage or cost. With `sessionExport` enabled (the default), every child writes one usage-only session file (tokens and cost, never transcript content) to:

```text
<active OMP agent dir>/sessions/.fabric/<encoded-cwd>/<run>.jsonl
```

Fabric attributes each file through a `session_info` marker (`fabricagent-<name>`). This placement works because tokscale and ccusage walk OMP's session store recursively, and OMP's own resume picker reads only its immediate `<encoded-cwd>` directory. **Both trackers count Fabric subagents with zero configuration, and OMP's session UI never lists these files**. The exported sessions behave like a co-hosted namespace inside OMP's store.

- **tokscale**: counted under the OMP client automatically. A small dedicated-client patch (senpi-style, pointing at `<active OMP agent dir>/sessions/.fabric`) turns it into a separate "OMP Fabric" row with per-`fabricagent-*` attribution.
- **ccusage**: counted in the default pi footprint automatically (`ccusage daily`, `ccusage pi …`). For an ad-hoc Fabric-only view, run `ccusage pi daily --pi-path <active OMP agent dir>/sessions/.fabric`.
- **Isolated store**: to keep usage files fully outside OMP's store, set `agents.sessionExportDir` (or `OMP_FABRIC_AGENT_DIR`) to `~/.omp-fabric/agent`, then register a ccusage named store for a dedicated `fabric` agent section:

  ```json
  { "pi": { "stores": [ { "name": "fabric", "path": "~/.omp-fabric/agent/sessions/.fabric" } ] } }
  ```

  ccusage's double-count guard rejects a named store that overlaps the default pi store, so the isolated-row form requires the separate directory.

See [agents, actors & mesh](agents.md) for the runner and transport details.

## MCP

- `mcp.disableOAuth`: when true, MCP calls can use cached credentials. New interactive OAuth flows stay disabled.
- `mcp.callTimeoutMs`: per-call timeout bound.
- `mcp.allowDynamicServers`: permit `mcp.register()` of ephemeral servers.
- `mcp.enabled`: set to `false` to disable the MCP surface.

Fabric keeps a per-project MCP descriptor cache at `.omp/fabric/mcp-cache.json`. The cache uses the same config layers as [mcporter](https://github.com/openclaw/mcporter): global settings from `~/.mcporter/mcporter.json` and project settings from `config/mcporter.json`. Tool discovery (`tools.list`/`search`/`catalog`) reads these cached descriptors. Sessions reuse them while the config stays equal. Config state alone controls validity. Per-server definition hashes preserve entries when another server changes. Whitespace-only edits also keep the entries valid.

Fabric handles staleness in stale-while-revalidate style. Sessions adopt the cache instantly and re-list servers in the background per policy. When a server fails, its last-known tools stay available, marked `stale` in `mcp.$servers`. Fabric always re-lists a server the first time a call connects to it.

- `mcp.cache.enabled`: turn the descriptor cache on (default: true). When false, discovery lists tools live with a 60s in-memory TTL, matching the pre-cache behavior.
- `mcp.cache.revalidate`: background re-listing scope at session start, one of `"changed"` (only added or reconfigured servers, the default), `"all"`, or `"off"` (explicit `tools.list({ provider: "mcp", namespace })` probes still fetch exactly that server).
- `mcp.cache.revalidateBudgetMs`: wall-clock budget for one background revalidation pass (default 60000). A leftover queue tail restarts with a fresh budget.

See the [`mcp` reference](../skills/fabric-exec/references/mcp.md) for the call surface.

## UI

- `ui.widget` is `auto`, `always`, or `hidden`. `auto` shows active or retained Fabric runs and worker activity. Active one-shot agents and actor workers occupy rows. Their recent nested tools appear beneath them when enabled.
- `ui.showAgentToolPreview` defaults to `true` and controls the child-agent and actor tool rows in both the parent `fabric_exec` card and the widget. Recursive agents render their full descendant tree, bounded by the preview depth/node budget. The version 2 config migration renamed this key from `ui.showNestedToolCalls`.
- `ui.toolDisplay` is `"compact"` (default) or `"full"`. Compact elevates the declared display name and description and keeps bounded nested tool detail visible; full retains the outer Fabric TypeScript transcript. OMP's tool-expand keybinding (`ctrl+o` by default) expands a compact card to the full transcript and collapses it again. Invalid values fall back to `"compact"`. If configuration fails to load, rendering falls back to full so a degraded startup never hides the transcript. Change it under `/fabric settings` → **UI**; successful changes apply immediately to live and completed cards.
- `ui.updateDebounceMs` defaults to `100`. It applies one execution-wide coalescing interval to every live `fabric_exec` card update: nested calls, progress text, and agent tool previews. Continuous streams emit at most once per interval, so a long call no longer postpones every render until completion. Set it to `0` to emit every update. Accepted values clamp to `0..2000`. The version 3 config migration renamed this key from `ui.nestedToolDebounceMs`.
- The widget renders above the chat, like `pi-supervisor`. Set `ui.enabled` to `false` to disable both the widget and the dashboard controller.

See the [interface reference](interface.md).

## Mesh

Mesh data lives at `<project>/.omp/fabric/mesh` by default. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and actor sessions. Add `.omp/fabric/mesh/` to the project's ignore file unless you version the coordination log on purpose. Set `mesh.enabled` to `false` to disable both mesh actions and ambient actor restoration.

`mesh.actorScope` is the default storage scope for `agents.create`; each actor can override it with `scope: "project"` or `scope: "session"`. Both scopes run concurrently:

- `"project"` (default) uses `.omp/fabric/mesh/actors/`. Actors survive `/new` and appear in every trusted OMP session for the project.
- `"session"` uses `.omp/fabric/mesh/actors/<sessionId>/`. Actors are isolated to the root OMP session and remain available to participant agents in that lineage. Use this for task-specific supervisors and private history.

In project scope, one host owns each actor runtime. Only that host drains host events and mesh subscriptions. Other sessions can read the shared definition, mailbox, and logs; set their own model and thinking binding; and route `ask`, `tell`, `steer`, `followUp`, and `stop` through the owner. They do not start another actor runtime.

If the owner lease and lineage root both disappear, a matching trusted host can adopt the actor. Main adopts session-resident actors. The resident host adopts durable actors. Adoption stores a new `rootId` and an `adoptedAt` fence under the registry lock. Concurrent starters converge on one owner. The 30-second fence gives that owner time to publish its participant record. Until every registry row has a matching owner, create or import can fail with `registry is owned by another host`.

Registry writes take a stale-safe lock and merge only actors owned by the writer. A local save preserves newer records from another owner.

`agents.setModel` and `agents.setThinking` change the current OMP session by default. In project scope, their binding files are separate from `actors.json`. Pass `scope: "project"` to change the shared default; only the owner can do so. Values passed to `ask` or `tell` affect one activation. Fabric resolves values in this order:

```text
call override → session binding → project default → Fabric default
```

`mesh.eventContextChars` bounds the sanitized JSON context attached to each host-event activation. Fabric extracts images first. It stores redacted image descriptors in the mailbox and registry, then sends the raw images to the actor out of band. The character limit never truncates image base64 because base64 is not part of that JSON context.

Mesh topics, shared state, and the participant directory remain project-scoped. Every runtime publishes one short-lived host lease and records for the roots, agents, and actors it owns. `agents.members()` and `mesh.members()` read those records. `agents.main()` and `agents.peers()` project roots. When a lease expires, its records leave normal discovery together. `mesh.actorPollMs` controls fallback polling for actor events and owner-addressed commands when filesystem notifications are unavailable.

## Compaction

The deterministic, LLM-free compaction engine is on by default. It keeps OMP's bounded `keepRecentTokens` continuity tail. `compaction.targetContextRatio` sets a hard occupancy ceiling. Set `compaction.engine` to `"omp"` to use OMP's native compaction or `"fabric"` to use Fabric's deterministic summary. See [compaction](compaction.md) for invariants, loss guarantees, sections, and limits.

## Catalog repairs

Silent invocation repairs are on by default. `repairs.enabled` controls the catalog-scoped table at `<active OMP agent dir>/fabric/repairs/current.json`. Inspect it with `/fabric repairs`. See [catalog repairs](repairs.md).

Continual entropy reduction is on by default. `entropy.compile` controls the autonomous compile loop and its enforcement: every turn with new `fabric_exec` evidence runs measure → propose → apply → gate against the live session window, and a passing compile persists `<agent dir>/fabric/entropy/compiled.json` beside the repair table. Inspect it with `/fabric entropy`. See [tool entropy](entropy.md).

## Update notice

Fabric watches npm for a newer published `omp-fabric` and shows one status line while the installed version is behind. `update.check` (default `true`) masters the check. The line names both versions and the upgrade command:

```text
omp-fabric 1.0.5 → 1.1.0 · omp plugin install omp-fabric
```

The check makes at most one plain GET to `https://registry.npmjs.org/omp-fabric/latest` per day, with no query parameters and no identifiers. Its cache lives at `<active OMP agent dir>/fabric/update-check.json` and records the last check time, the latest published version, and the version already announced. A session inside that 24-hour window reads the cache and reaches the network zero times.

Every failure path stays quiet. An offline machine, a DNS failure, a non-200 answer, a throttled registry, malformed JSON, and an unwritable cache all leave the session exactly as it was. A version equal to or newer than the published one stays quiet too, which is the normal case for a local checkout loaded with `-e`.

Fabric announces each version one time. Later sessions on the same published version stay quiet until a newer version appears. Sessions with no UI (print and RPC mode), spawned child agents, and actor runtimes skip the check. It starts at session start and never delays the first turn.
