# Interface & commands

Fabric builds its UI on the public `pi-code-previews` cooperative shell and on a general-purpose, theme-aware activity surface. You do not need to install `pi-code-previews` separately.

## Code previews

`fabric_exec` inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing. It does not take ownership of OMP's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase and call activity, and compact phase and nested-call summaries. Preview settings live in the unified Fabric configuration: the `codePreview` section of `<active OMP agent dir>/fabric.json` (global) or `.omp/fabric.json` (trusted project). You can edit them live under `/fabric settings` → **Code previews**. Fabric no longer reads the standalone `code-previews.json` file or the `codePreview` keys in OMP settings. `codePreview.shikiTheme` defaults to `"auto"`. That value tracks OMP's resolved light/dark variant (GitHub Light on light terminals, Dark+ on dark) as OMP auto-switches. A `"<light>/<dark>"` value pins both variants. Any other value fixes one shiki theme.

Nested `omp.read`, `omp.bash`, `omp.grep`, `omp.find`, `omp.ls`, `omp.write`, and `omp.edit` calls share the preview settings and presentation vocabulary of `pi-code-previews`: offset-aware read gutters, syntax and secret warnings, grouped and highlighted grep matches, iconized path trees, bash warnings and output metadata, and proposed or applied edit and overwrite diffs with compact context, line gutters, full-row backgrounds, and word-level emphasis. Large inputs fall back to escaped plain text with an explicit notice. The same layer renders in-memory Activity call details. Fabric keeps rich call data only in current-session renderer and activity state. Durable traces keep their existing bounded confidentiality projection.

Fabric keeps its orchestration-specific behavior around those previews. Multi-call rows stay compact, and live write composition with phase/call progress stays visible during the run. Agent and actor audits can expose their current child tools directly in the parent card, with owner, runner, and run metadata. One execution-wide throttle coalesces parallel nested-call updates before they reach OMP, and continuous streams are not starved. Long ANSI rows are bounded without clearing the enclosing tool background. The widget lease plus result-to-source row transfer keep completion height stable. The highlighter initializes lazily and falls back to plain text until it is ready. When OMP switches between its light and dark variants, the highlighter swaps themes live. Collapsed previews use the configured expand keybinding, for example `Ctrl-O`.

## Focused conversations

Press **Ctrl+Shift+A** (or the key set in `ui.conversationShortcut`) or run **`/fabric chat`** to open a full-screen conversation without going through the dashboard. `/fabric chat <id-or-name>` opens a specific agent or actor; Tab completes exact participant IDs, including nested agents. Ambiguous names or ID prefixes are rejected; use an exact participant ID to select the intended target. In the dashboard, **Shift+C** opens the selected participant.

The first implicit open prefers a currently active child over stale history; later opens remember a valid selection. The view keeps a lossless native OMP transcript and a multiline editor together, independently of the dashboard’s bounded transcript projection. OMP 19.2 no longer exposes its transcript components to extensions, so Fabric draws the transcript with pi-tui: user prompts sit on the user message background, assistant text and thinking go through pi-tui Markdown, a tool with a registered `renderCall` or `renderResult` (such as `fabric_exec`) draws itself, and any other tool shows a compact card with its arguments and a result that the tool-expand key unfolds. Images inside tool results are not shown. User backgrounds and editor rules span the terminal width. Fabric reads only `hideThinkingBlock` from OMP’s global settings plus a trusted project layer; untrusted sessions use an in-memory OMP instance with schema defaults (`hideThinkingBlock: false`). The footer below the editor shows the selected participant’s directory, known branch, model, thinking level, and run-scoped token/cache/cost statistics. Unknown usage and context occupancy are marked explicitly; Main’s statistics are never substituted. Breadcrumbs preserve `Main → child → grandchild` lineage. Main and other participants keep running: opening, navigating, and closing the view never calls OMP’s session-replacement API or starts another worker. Selecting Main restores the original OMP conversation, including its editor. Child drafts and scroll positions survive switching targets and reopening the view for the lifetime of this OMP session.

| Control | Action |
| --- | --- |
| Enter | Send a steering message to the selected live participant |
| Follow-up key (Alt+Enter by default; Ctrl+Q on Windows) | Queue a follow-up for the selected participant |
| Shift+Enter | Insert a newline |
| Ctrl+N or `/agents` | Open the searchable participant picker |
| Alt+Left / Alt+Right at an empty editor | Navigate to parent / first child |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle conversations |
| Mouse wheel / configured OMP scroll keys | Scroll locally and fetch older history. The wheel reaches the view while OMP mouse reporting (`tui.mouse`) is on; with it off, a terminal that turns the wheel into arrow keys on the alternate screen scrolls through the line keys |
| End | Follow the latest output |
| OMP's tool-expand key (Ctrl+O by default) | Toggle tool details |
| `/stop` | Explicitly stop the selected participant after confirmation |
| Esc or `/back` | Return to Main without interrupting any agent |

Direct actor messages appear as normal user text, with paired RPC start/end events shown once. Session branches and compaction remain authoritative over overlapping RPC history. Native message errors remain visible. Use `/fabric log <id>` to inspect worker startup diagnostics. The widget advertises `Ctrl+Shift+A chat` only while an agent or actor is active, and removes the hint when work settles. The command and shortcut remain available for idle and historical conversations.

Pending messages use OMP’s native labels and spacing. When a compatible loaded `pi-queue-steer` provides `queue-steer:conversation-queue:request:v1`, the view uses its actual per-target queue, execution-outline widget, and inline editor. A stopped actor’s Alt+Enter input is parked for editing or explicit Enter release. Accepted sends remain visible until native delivery is observed; they cannot be retracted or edited locally. Queues stay isolated from Main and other targets, survive preview close/reopen within the session, and are cleared on session reset. Older queue-extension releases without the bridge use the native display.

Messages use the same ownership-aware route as `agents.steer` / `agents.followUp`. A failed delivery keeps the draft. Capability and lifecycle checks run again at dispatch, so a child that finishes while you type cannot silently receive a message in Main or be respawned. Persistent actors accept subsequent mailbox messages, including while idle. Finished one-shot runs remain readable but cannot continue; Veda one-shot runs do not support mid-run messaging. A remote participant without an accessible transcript shows an explicit transcript-unavailable notice.

This is a focused view over the existing worker, not a second native OMP runtime. Other OMP slash commands, shell shortcuts (`!`), and child extension dialogs are not routed through this view. Unsupported commands are rejected visibly, never forwarded to Main. Native image attachment and full command/extension parity require a separate worker attachment protocol. The existing dashboard retains model, actor-policy, and configuration controls.

## Activity surface

Fabric ships a general-purpose, theme-aware activity surface that works with any agent setup:
- A compact widget above the chat (like `pi-supervisor`) follows the current phase in its header. It lists active and completed one-shot agents plus active actor workers. Their recent or running child tools nest beneath the owner, with compact edit/write change lines and owner metadata. Extensions, custom items, and shared tasks/state stay summarized by the header or appear in the dashboard, so they never occupy widget rows. The widget retains completed agent rows and a per-run high-water height, which stops tool finalization from pulling the chat upward. It resets that lease when a newer run starts, and the latest completed summary stays visible until that newer run replaces it. Snapshot bounds first preserve every active local agent, then local history, and only then admit remote project records. When a collapsed Fabric result becomes shorter at completion, the card reveals a bounded number of otherwise hidden TypeScript source lines. Those lines replace the removed rows without blank padding, and any residual deficit shrinks naturally.
- `/fabric` (or `/fabric dashboard`) opens a responsive full-screen overlay with two views: **Activity** and a unified **Topology**. Press `1` for Activity and `2` for Topology.
- `/fabric settings` opens an inline settings view that mirrors OMP core's `/settings`, with top and bottom borders, fuzzy search, and section submenus, and it writes changes to `fabric.json`. Every session opens at the global `<active OMP agent dir>/fabric.json`. In a trusted project, pressing **Ctrl+G** anywhere in the view switches both the displayed configuration layer and the save destination to the `<project>/.omp/fabric.json` overrides and back. The global view keeps global edits visible even when a project override remains effective, and its scope banner states that precedence explicitly. Untrusted sessions stay global-only. In RPC hosts, the same hierarchy is exposed through recursive select/input dialogs; a root save-scope action replaces the Ctrl+G shortcut, while Back returns one section at a time. Full code mode, capture, executor, approvals, and UI changes apply immediately when they change the effective configuration. Mesh, agent, retention, and MCP changes persist and take effect on the next `/fabric reload`. The UI section includes **Tool display** (`full` by default or `compact`), a default-on **Agent tool preview** toggle, and a global **Update debounce** (`0`/Off through `1000ms`, default `100ms`); all apply immediately. Compact display makes the declared Fabric display name/description the card header, hides outer TypeScript at every expansion level, and retains bounded nested tool details. The Agents section selects the default runner, keeps independent OMP and runtime-enumerated Claude model pickers, and exposes free-text Veda backend, persona, and model fields for the Veda runner. List editors for `agents.defaultTools` and `capture.keepVisible` toggle known tools on and off. The `keepVisible` candidates include `fabric_exec` plus every captured extension tool.

### Keybindings

- In `/fabric settings`, the view starts at global defaults, and **Ctrl+G** switches the displayed values and the save destination to trusted-project overrides and back. Untrusted sessions remain global-only.
- Press `1` for Activity and `2` for the unified Topology. In Topology, arrow keys move spatially between graph nodes, `h`/`l` mirror left and right, `j`/`k` follow deterministic entity order, and Tab advances to the next node. In Activity, arrows or Tab switch panes and select rows. `g` and `G` jump to the first and last selectable entity, Enter inspects, `f` cycles status filters, `[`/`]` change the retained-run lens, and `?` opens contextual help.
- On Main, `s` sends a user-authored message or steer, and `u` queues a user-authored follow-up through OMP's host queue.
- On agents and actors, Space peeks at the transcript and `t` toggles transcript/summary detail. Inside a transcript, `g` loads and jumps to the true top, and `G` jumps to the bottom and follows new output. On active one-shot agents, `s` opens a steer editor, `u` queues a follow-up, and pressing `x` twice stops the run. Remote participants expose capability-aware, owner-acknowledged `s`, `u`, and `x` controls.
- On actors, `s` queues a serial mailbox message. Lowercase `m` and `e` change this OMP session's model and thinking. Uppercase `M` and `E` change the shared project defaults and appear only on the owner. Actor detail shows both layers, the effective values, and the live owner.
- Owner views also expose `v` for host events, `i` for instructions, and other shared actor settings. Passive views hide those controls but keep session bindings, messaging, reads, and `x` export. `p` imports a global template, `d` deletes one, and Esc backs out or closes.

## Data-driven activity

The surface is data-driven. Fabric automatically instruments nested provider calls, agents, persistent actors, and task-shaped mesh entries. A workflow can add domain-specific labels and arbitrary progress, and it needs no extension UI code:

```ts
await workflow.configure({ name: "Release train", description: "Build, verify, and publish" });
await phase("Build", { total: packages.length });
await workflow.item({
  id: "docs",
  label: "Documentation",
  status: "running",
  completed: 2,
  total: 5,
});
await workflow.event({ message: "Canary passed", level: "success" });
```

External Fabric providers can emit structured `context.activity()` updates for an entity, a progress message, or metrics. The TUI stays generic, and a virtual provider can still expose richer live state.

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Host terminal internals

The pi-tui root export covers nodes, signals, and events. Fabric also calls five pi-tui modules that OMP serves from its binary without a stability promise: `term/paint`, `term/widgets`, `term/render`, `term/keymap`, and `driver/input/decoder`. Fabric loads them with dynamic imports when its UI module loads and checks each export it calls. When a later OMP release drops one of these modules or exports, Fabric still loads, and its startup warning names what is missing:

| Missing module | Fabric falls back to |
| --- | --- |
| `term/paint` or `term/widgets` | The view paints as a plain `canvas` node. Mouse wheel scrolling stops; the scroll keys keep working. |
| `term/render` | A preview drawn by a host tool renderer shows one notice row. Fabric's own renderers keep drawing. |
| `term/keymap` | The default pi-tui widget keys. Keys rebound in OMP settings do not apply to Fabric views. |
| `driver/input/decoder` | Keys come from the host key event the view just received. Bracketed paste still works; other input that does not arrive as a host key event is ignored. |

Text helpers (`text/width`, `text/markdown/render`, `theme/theme`) and other host modules stay static imports. `bun scripts/check-host-imports.mjs` lists every `@oh-my-pi/*` specifier and named import in `dist/` and imports each one from the installed host packages. A missing static import fails the check, and a missing dynamic import is reported as a fallback. Pass `--binary "$(command -v omp)"` to also check each specifier against the module map compiled into an OMP binary. CI runs the check after the build. Run it with `--binary` against a new OMP release before raising the host floor.

## Commands

```text
/fabric status
/fabric dashboard
/fabric chat [participant-id-or-name]
/fabric settings
/fabric reload
/fabric providers
/fabric captured [query]
/fabric agents
/fabric actors
/fabric messages <actor-id>
/fabric attach <agent-id>
/fabric stop <actor-or-agent-id>
/fabric repairs
/fabric entropy
```

Actor slash commands mirror the [global template API](agents.md#global-actor-templates). `/fabric global` lists templates. `/fabric import <name> [as <new>]` stamps one into the project. `/fabric export <id> [--overwrite]` promotes a project actor. `/fabric log <id>` previews an actor or run transcript, and `/fabric export-log <id> [path]` writes the raw `session.jsonl` plus retained `runs/` to disk.

## Headless focused agents

OMP already runs one-shot, non-interactive agents with `omp -p` (`--print`), and it reads piped stdin as part of the prompt. A focused agent composes with pipes, cron, git hooks, and CI like a Unix program, and it needs no wrapper:

```bash
git diff | omp -p --no-session --tools read,grep "Review this diff for concrete defects."
omp -p --no-session --mode json -e <path-to-omp-fabric> "Map the persistence layer."
```

`--no-session` keeps the run ephemeral. `--tools` restricts the tool allowlist. `--mode json` emits a structured event stream for scripting through `| jq`. `-e <omp-fabric>` loads Fabric so the agent can use `fabric_exec`. The process exits non-zero on failure. Run `omp --help` for the full flag list.
