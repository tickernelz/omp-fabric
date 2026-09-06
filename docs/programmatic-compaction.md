# Programmatic compaction

A model, skill, or peer can **ask** the host to compact its context at a safe
boundary. The request also works on a running agent's context.

One gated channel carries the request to the host. The host selects the safe
time. Fabric performs deterministic compaction without another model call,
which keeps repeated results testable. Each request records a labeled
**advisory** intent. The host later performs the **committed** context change.

## Advisory and committed steps

The model runs inside the context that it requests to compact. A direct change
during the active turn could race with in-flight tool work or unresolved state.
Fabric records the request through a typed, validated write path. An open status
path reports its state.

1. **Advisory.** `compact.request` (host) or `agents.compact` (child) only
   *records an intent*. The request never touches the context. It is a
   write-risk, schema-validated declaration: "Compact this context with these
   instructions. Reason: <reason>."

2. **Committed.** At a boundary it knows to be safe, the host forwards the
   intent to `ExtensionContext.compact()` for the host session, or to the
   child OMP's `compact` RPC frame for a child. The host boundary is
   `agent_end`: the handler awaits OMP's callback completion or error
   before OMP publishes its public settled event. For a child, the worker waits
   for the child's own `agent_end`. It then sends a correlated compact
   request and keeps the RPC channel open until it observes the correlated
   response, which the host sends for an explicit compact. An
   `auto_compaction_end` from the host's automatic pass only records an abort or
   error on the outcome. The worker never sends compact while the child turn is
   active.

Exactly one write path leads from intent to action. The model cannot compact
the running context directly. It can only ask. The controller stores one replaceable
request. A new request replaces the pending one, so the slot always holds the
latest instructions.

## Compaction properties

| Property | Fabric behavior |
| --- | --- |
| The context is a cache for the store. | Compaction changes the cache through an explicit, labeled transition. `status()` records the intent and last commit outside the context, where they survive compaction. |
| Derived views are pure functions of the log. | `CompactStatus` reads the controller's recorded intents and commits. It never reads the compacted context itself. |
| The host enforces transition boundaries. | The model requests compaction. The host commits at `agent_end`. `maybeCommit` and the `agent_end` handler contain the boundary gate. |
| A task boundary can carry a compaction request. | The model selects the request time and instructions. The host selects a safe commit time. OMP core keeps its token-threshold trigger. |

## API surface

### Host session: the `compact` provider

The provider is always available, with no config guard. Fabric exposes it
through `fabric_exec` as `compact.request`, `compact.status`, and
`compact.cancel`.

```ts
// Record an advisory intent. Replaces any pending one and returns
// immediately. The host commits it at the next agent_end boundary.
await compact.request({
  reason: "the file map and the failing test are the only live state",
  instructions: "Keep the failing test name and the file map; drop the rest.",
  preserve: ["Auth regression is still open", "tests/auth.test.ts"], // optional
  requestedBy: "model", // optional, default "model"
});

// Read the pending intent and the last committed/failed compaction info.
const status = await compact.status();
// { pending?: { reason?, instructions?, preserve?, requestedBy, requestedAt },
//   last?:   { at, requestedBy, status: "committed"|"cancelled"|"failed",
//             summary?, tokensBefore?, estimatedTokensAfter?, error? } }

// Clear a pending intent before the host commits it.
await compact.cancel();
```

Risk classes: `request` is `write` (it mutates host session state). `status`
and `cancel` are `read`.

With only `instructions` present, Fabric forwards it as ordinary OMP
`customInstructions`. Manual `/compact` text and programmatic requests then
get the same Fabric rendering. When `preserve` is present, the controller
encodes `{version: 1, instructions?, preserve}` behind an exact versioned
prefix plus JSON. The compaction and branch hooks strictly decode that shape
and render valid bounded values under `[Compaction Request]`. On tree
navigation, OMP's explicit `replaceInstructions: true` mode delegates to
OMP/default summarization. Fabric cannot execute an arbitrary replacement
summarizer prompt, so it produces no typed Fabric branch details in that mode.

The prefix is reserved. Malformed JSON or scalars, duplicate decoded protocol
keys (including escaped aliases), unknown fields or versions, invalid types,
unpaired UTF-16 surrogates, excessive structure, or exceeded limits return a
structured decode error and cancel the operation. Fabric never falls back to
prose for such a payload. A bounded structural parser performs these checks
before canonicalization, and it never uses regex to recover protocol
data. Fabric never renders a rejected payload. A context with UI/RPC notification support
receives a bounded error. Ordinary manual and OMP instructions remain explicit text and
never gain routing semantics.

`compact.request` validates its input with a bounded TypeBox schema before
argument mapping. Instructions cap at 8192 characters and 8192 UTF-8 bytes.
`preserve` accepts at most 16 items, and each item caps at 2048 characters and
2048 UTF-8 bytes. The complete encoded prefix-plus-JSON request must fit
within 16 KiB. The decoder checks aggregate source bytes before structural
parsing, then validates duplicate keys, scalars, and surrogate pairing while
parsing. It checks the preserve count before iterating or canonicalizing
items. Ordinary manual and OMP instructions remain bounded explicit text and
never become typed protocol input.

#### Commit semantics

- The host's `agent_end` handler awaits `maybeCommit(context)`. It never
  runs mid-turn or while a turn is in flight. The returned Promise settles on
  `onComplete`, `onError`, a synchronous startup throw, or a pre-start abort.
- The call is a no-op when nothing is pending. Reentrant calls share the
  in-flight Promise and never start a second compaction.
- Fabric accepts a new `request()` during an in-flight commit, and that
  request replaces the pending intent. The in-flight commit proceeds with the
  intent it captured.
  On completion it clears *that* intent by identity, and any newer intent
  waits for the next settled boundary.
- On OMP's `onComplete`, Fabric clears the intent and `last` records
  `status: "committed"` with the summary and token counts.
- On OMP's `onError` with `"Compaction cancelled"` or `"Already compacted"`,
  Fabric clears the intent and `last` records `status: "cancelled"` with the
  raw OMP message in `error`. No compaction happened, and the outcome stays
  observable without being silently dropped.
- On any other error, Fabric clears the intent and `last` records
  `status: "failed"` with the message. A synchronous throw from `compact()`
  itself follows the same failure path.

### Agent compaction: `agents.compact`

```ts
const handle = await agents.spawn({
  task: "Audit auth flows.",
  tools: ["read", "grep", "find", "ls"],
});

// Advisory: the worker queues this until the child is fully settled.
await agents.compact({ id: handle.id, instructions: "Keep the finding list." });

return await agents.wait({ id: handle.id });
```

- Fabric appends the request to the same `<runDir>/steer.jsonl` channel as
  `agents.steer`. The orchestrator, or any peer through the mesh relay, can
  request a child compaction without stopping or respawning the child, and the
  child keeps its accumulated context.
- The worker tails `steer.jsonl` and never forwards compact during an active
  child turn. It waits for `agent_end`, then sends
  `{"id":"...","type":"compact","customInstructions":"..."}`, with the
  instructions field omitted when absent. This matches OMP's RPC `compact` frame.
- The worker correlates the compact response by `id`. It observes the matching
  compaction lifecycle through `auto_compaction_end`, records queued, in-flight,
  completed, or failed status, and only then closes stdin for one-shot
  shutdown. The worker records a rejected response, an aborted compaction,
  or an `auto_compaction_end.errorMessage` as failed, and the child turn keeps
  running.
- Multiple requests that wait before the boundary coalesce into one request
  with the latest instructions. Requests that arrive during an in-flight
  compaction merge into one deterministic follow-on request before shutdown.
- Fabric **rejects Claude-runner children** with a clear error. The official
  Claude Code CLI exposes no compact RPC, so a fresh run is the only way to
  reset a Claude child's context. Compaction is an OMP-runner primitive.
- Risk class: `agent`.

## Audit and observability

- **Activity surface**: `compact.request` and `agents.compact` emit
  `context.activity` updates (entity + progress) inside the `fabric_exec` call
  that issued them, following the existing provider pattern. Host commits and
  child enqueues show up in the dashboard and widget.
- **Mesh**: when the mesh is enabled, the host controller publishes
  best-effort events to the durable `fabric.compact` topic on each transition.
  Recorded intents publish `kind: "requested"`, and settled intents publish
  `kind: "committed" | "cancelled" | "failed"`. OMP's benign
  `"Compaction cancelled"` and `"Already compacted"` outcomes publish with
  `kind: "cancelled"`. Other Fabric participants, such as persistent actors
  and peer sessions, can subscribe to observe compaction transitions.
  Activity-only sessions with the mesh disabled silently skip this step.
- **Status query**: `compact.status()` gives the context-independent,
  in-memory record of the pending intent and the last commit for the current
  initialized extension session. The record survives compaction itself.
  Extension reload, session replacement, process restart, and shutdown clear
  it.

## Configuration

None required. Programmatic compaction is a first-principles primitive and
always available. Fabric defines no `compact` config block. The
model decides when and how to ask, and the host decides when to commit, so
safety needs no configuration.

## Files

| File | Role |
| --- | --- |
| `src/core/compact-controller.ts` | Pending-intent controller with `request`, `cancel`, `status`, and `maybeCommit`. Uses a single replaceable slot, typed preserve encoding, an in-flight guard, and a quiet clear on cancelled or already-compacted outcomes. |
| `src/providers/compact-provider.ts` | Fabric provider that exposes a bounded TypeBox-validated `request` (write, including optional `preserve: string[]`), `status` (read), and `cancel` (read). Registered always, with activity audit. |
| `src/fabric-state.ts` | Constructs the controller with mesh-publish hooks, registers the provider, and resets on re-init or shutdown. |
| `src/index.ts` | Invokes `state.compact.maybeCommit(context)` in the existing `agent_end` handler. |
| `src/agents/types.ts` | Extends `AgentSteerEntry["type"]` with `"compact"` and adds the optional `instructions` field. |
| `src/agents/manager.ts` | `compact(id, instructions?)` appends a compact entry through the steer channel and rejects Claude-runner children. |
| `src/worker.ts` | Feeds compact controls into the child boundary coordinator and observes OMP RPC lifecycle events. |
| `src/agents/compact-control.ts` | Coalesces child requests, waits for `agent_end`, correlates the compact response with `auto_compaction_end`, records the outcome, and gates one-shot stdin close. |
| `src/providers/agents-provider.ts` | `agents.compact({id, instructions?})` action (risk: agent) with activity audit. |
