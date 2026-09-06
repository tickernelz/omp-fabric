# Deterministic compaction

OMP Fabric provides an LLM-free compactor through `session_before_compact`. This compactor is the default engine. Set `compaction.engine` to `"omp"` to defer to OMP's native compactor.

Fabric keeps a bounded recent raw continuity tail after compaction. The tail uses OMP's active `keepRecentTokens` setting, which defaults to 20,000 tokens. Fabric rebuilds the older state into its deterministic summary. OMP's native cut and Codex-style checkpoint compaction use the same fresh-window principle. The summary carries durable state, and a small raw suffix keeps the recent conversation coherent for the model.

`compaction.targetContextRatio` sets a hard occupancy ceiling that applies after compaction. Fabric never treats the ceiling as space to fill. The value defaults to 65%, and you can change it from `/fabric-settings` (shown as **Max occupancy**) or in JSON. Allowed values are bounded to `0.25`–`0.85`:

```json
{
  "compaction": {
    "engine": "fabric",
    "targetContextRatio": 0.65
  }
}
```

Configure OMP's continuity tail in OMP's `settings.json`:

```json
{
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

Use `{ "compaction": { "engine": "omp" } }` to defer to OMP's native compaction engine.

`/fabric settings` also exposes a **Threshold** for the active model. It
supports two modes: a window-occupancy percent or an exact token count
("Custom tokens…"). Fabric stores thresholds by canonical `provider/model`
key, so switching models selects that model's own value. `OMP default` clears
both maps and leaves OMP's built-in threshold unchanged.

```json
{
  "compaction": {
    "thresholds": {
      "anthropic/claude-sonnet-4-5": 0.8,
      "openai/gpt-5.4": 0.9
    },
    "tokenThresholds": {
      "google/gemini-3-pro": 400000
    }
  }
}
```

Fabric bounds percent thresholds to `0.25`–`0.95` and rounds token thresholds
to integers bounded to `1,000`–`100,000,000`. When a hand-written config sets
both for one model, the token threshold wins. A configured threshold makes
Fabric trigger compaction at a safe settled boundary once the active model
reaches it. OMP's own automatic compaction keeps its built-in trigger: the
host's `session_before_compact` event carries no trigger reason, so Fabric
cannot tell an automatic threshold compaction apart from an overflow or manual
one and never defers the host's automatic pass.

## Invariants

1. **The session log is ground truth.** The summary is a bounded continuation view with stable entry-id and file addresses.
2. **Live cut and cumulative truth are separate.** The cut comes from the window made live by the last compaction. Fabric rebuilds the summary from every raw, typed, content-bearing entry on the supplied active branch prefix before the new kept boundary.
3. **Rendered summaries are never semantic input.** `compaction` entries, branch-summary prose, custom summary prose, and unknown roles produce no normalized events. A valid Fabric branch-summary details envelope may contribute its typed facts. Its `summary` string never contributes. Top-level OMP `custom_message` entries work differently: OMP puts them in model context, so Fabric preserves their typed `customType`, text content, visibility, and bounded JSON details. `custom` state entries that bear no context remain excluded.
4. **Structure drives projection.** The core uses entry/message types, roles, content-part types, custom-message fields, tool names, typed `fabric_exec` display fields, JSON arguments, call ids, `isError`, aggregate trace outcomes, exit codes, entry ids, ordering, valid Fabric execution traces, and valid Fabric branch-summary facts. It applies no semantic regex over prose, code, shell commands, or tool output. Whitespace normalization, bounded truncation, exact identity comparisons, and path segmentation stay mechanical.
5. **Serialization is deterministic and bounded.** Identical branch entries and instructions produce byte-identical output. The rendered result is at most 32 KiB in UTF-8.
6. **The nominal model window is the safety boundary.** Fabric never treats it as a target to fill. Fabric calibrates OMP's structural token estimate against `preparation.tokensBefore`, retains the largest closure-safe suffix within OMP's bounded `keepRecentTokens` continuity budget, and treats the configured occupancy ratio, OMP response reserve, estimator-error margin, and pre-compaction size as hard ceilings. Undocumented provider headroom never enters the budget.

These invariants prevent summary-chain drift and deterministic
forgetting. OMP replaces the previous rendered summary on each compaction.
Fabric still re-derives the original goal, cumulative successful file
addresses, error state, and user scope changes from raw branch history every
time.

## Loss model and memory

Fabric compaction is **source-lossless and addressably lossless**. The model's bounded continuation view does not stay byte-for-byte lossless:

- Compaction appends a marker. It never deletes or rewrites raw session JSONL. The active parent-linked session branch remains ground truth.
- The model receives a bounded deterministic projection plus the recent raw continuity tail. Fabric preserves typed goals, declared Fabric run intent paired with aggregate outcomes, file operations, failures, status, and stable addresses through mechanical rules. Arbitrary old prose, tool-output bodies, and thinking may fall out of the inline view.
- Every sampled omission records a count and source entry-id range. `memory.expand` can re-read exact untruncated source by stable entry ID or operation address with source-hash and lineage checks.
- The memory index remains derived and disposable. Compaction works without successful indexing, and it never treats an incomplete index as ground truth. Exact expansion reads session JSONL.

Near-lossless continuation comes from three layers: dense typed projection for
normal work, a bounded raw tail for immediate local coherence, and
integrity-bound source recall for exact old detail. Deleting the source
session removes the final exact-recall layer.

## OMP pipeline

```text
active branch entries ─┬─► live window ─► calibrated token budget ─► closure-safe cut ─► firstKeptEntryId
                       └─► raw cumulative prefix ─► normalize ─► project ─► bound/render
```

- `normalize.ts` converts raw message and top-level `custom_message` entries to typed events. It selects custom content only from typed string or text parts, keeps JSON details depth/node/collection/string/byte bounded, and omits malformed details while otherwise valid content stays. Assistant thinking parts count as deliberation, so normalization never turns them into events. Summaries carry side effects and state, and truncated scratchpad text that could read as fact stays out. The compactor records how many thinking blocks it erased, so the omission stays auditable. Only `toolCallId` pairs each tool call with its result. A completed `fabric_exec` with a non-empty typed `display.name` contributes a bounded declared-intent event that carries its optional `display.description`, aggregate outcome, and call address. A `fabric_exec` result contributes nested events only through a valid `details.trace` V1 guard, or through the separate strict legacy `details.audits` adapter when no `trace` field exists.
- `projections.ts` computes goal, file, operation-state, turn, status, and transcript views.
- `enrichers.ts` permits deterministic optional annotations. Fabric ships no built-in enrichers.
- `render.ts` independently bounds every rendered block and enforces the global UTF-8 limit.
- `hook.ts` computes the live cut, selects cumulative source, and emits v2 details for the configured OMP or Fabric engine.

## Live cut and closure

The last compaction marker identifies the live window:

- a valid `firstKeptEntryId` starts the window at that entry.
- a compact-all marker or missing/orphan kept id starts it after the marker.
- without a marker, the whole supplied active path is live.

When OMP supplies the active model metadata, Fabric chooses the live cut from a calibrated bounded continuity budget:

1. Sum OMP's public structural message estimates for the current context.
2. Calibrate that estimate with `preparation.tokensBefore`, which compensates for provider tokenization, system prompts, tool schemas, and other fixed context that a character heuristic cannot observe directly.
3. Set the continuity target to calibrated fixed overhead plus OMP's `keepRecentTokens` and the maximum 32 KiB summary reservation. The absolute recent-tail budget does not grow with a 200K, 1M, or proxy-inflated advertised window.
4. Clamp that target to all independent safety ceilings: `contextWindow × targetContextRatio`, 90% of `contextWindow - reserveTokens`, and 95% of `tokensBefore`. The last ceiling prevents a low-usage manual compaction from expanding context. The advertised window is authoritative for threshold and manual compaction. Overflow recovery treats the failed request as stronger evidence: an API rejection proves the effective window is below `tokensBefore`, so Fabric first clamps the working window to 90% of the observed failed size.
5. Select the earliest eligible boundary whose retained suffix fits the resulting raw-tail budget. Suffix size decreases monotonically, so this boundary gives the largest legal raw suffix. User/custom boundaries and assistant boundaries are both eligible, which lets Fabric split a single enormous autonomous turn during compaction. On repeated compaction, the kept boundary must follow the previous compaction marker in raw log order. OMP replays entries contiguously from `firstKeptEntryId`, so a boundary before that marker would replay the old rendered summary beside the new one.

Fabric computes structural spans for every call id across the supplied branch
and rejects every candidate cut that separates an actual call/result pair.
This enforces both directions:

- a summarized tool call never has a kept result.
- a kept tool call never has a summarized result.

This pairing check handles parallel calls, delayed results, reverse or
malformed ordering, and malformed prior boundaries. When no non-crossing
boundary fits, Fabric uses compact-all (`firstKeptEntryId: ""`), and no kept
side remains to orphan either half. If the rendered deterministic summary
itself would push the calibrated projection over the target, Fabric cancels
the compaction to avoid persisting an expanding or over-budget result. If
model metadata is unavailable, the legacy latest-turn closure-safe cut remains
as a compatibility fallback.

The live cut determines only what OMP keeps. The summary source is the raw
active-branch prefix before that new boundary. Normalization skips earlier
compaction and branch-summary prose within that prefix.

## Bounded sections

Fabric emits the original first user goal first. Later user scope changes and
the potentially large file, operation-state, and earlier-turn collections use
deterministic earliest-plus-latest sampling. Every omission records a count
and a source entry-id range. File lines also carry the source call entry id.

Rendered block limits include their headers:

| Block | UTF-8 limit |
| --- | ---: |
| `[Session Goal]` | 4096 bytes |
| `[Compaction Request]` | 3072 bytes |
| `[Files And Changes]` | 4608 bytes |
| `[Fabric Activity]` | 2048 bytes |
| `[Outstanding Context]` | 4608 bytes |
| `[Earlier Turns]` | 3072 bytes |
| `[Current Status]` | 2048 bytes |
| collapsed transcript | 5120 bytes |
| footer | 1536 bytes |

The limits sum below 32 KiB, leaving room for separators. A final UTF-8 guard
enforces the global limit. Projection limits stay finite: 24 later goals, 24
file addresses per operation kind, 32 operation-state records, 48 Fabric
activity records, 32 earlier turns, and 40 transcript events. Omitted source
remains executable-addressable through entry-id ranges and the footer recall
pointer.

## Sections

- **Session Goal**: up to three bounded lines from the original first user message, followed by sampled later user scope changes.
- **Compaction Request**: canonicalized, bounded custom instructions. See below.
- **Files And Changes**: successful typed file-tool addresses grouped as Created, Written, Modified, or Read. `edit` counts as Modified. `write` counts as Written unless a typed result explicitly proves creation.
- **Fabric Activity**: completed named `fabric_exec` runs as bounded `name → outcome` records that place an em dash between the name and the optional description, followed in source order by phases and significant non-file nested operations, including bash, agents, workflow, mesh, state, MCP, and extension refs. Named runs expose the exact assistant call entry ID while sourced raw, and their typed fact address after branch rehydration. Nested phases and operations expose stable `entryId/subordinal` addresses. The name and outcome are mandatory for a rendered run. The optional description decays first under tighter views.
- **Outstanding Context**: typed tool/bash failures and later exact structural resolutions. File failures require the same action and path, bash failures the same command, and generic failures the same ref and arguments. Fabric quotes explicit error text with bounds and never parses or classifies it. Trace failures use only `operation.outcome` and `operation.error`.
- **Earlier Turns**: sampled user/custom context one-liners, tool-name counts, and the latest named Fabric run plus outcome for each summarized turn.
- **Current Status**: the latest summarized user/custom context, modification address, named Fabric run plus outcome, and assistant line.
- **Transcript**: the latest 40 typed events, including quoted and bounded custom-message content and bounded structural details, plus an omission range when applicable. A completed named `fabric_exec` replaces its generic outer call/result pair with `name → outcome`. The description stays in the richer Activity tier.
- **Footer**: deterministic source timestamp, cumulative source range, and session-log recall guidance.

Fabric omits commit projections. The core ignores `git commit`
command prefixes, and it never pulls hashes or summaries from shell stdout. A
caller that needs a commit ID across compaction must provide it explicitly
through a valid typed `preserve` item or another typed state transition.

## Remaining structural text operations

The clean core retains only these mechanical text operations:

- select text from typed user, assistant, top-level custom-message, tool-result, Fabric display-name/description, command-argument, error, phase, ref, and path fields.
- split user text on literal newlines for bounded goal lines, or select the first line for one-line views.
- trim/collapse whitespace and truncate by fixed character or UTF-8 byte limits.
- quote bounded user/custom/assistant/tool/error text without interpreting its content.
- compare typed action/path, action/command, or ref/JSON-arguments identities exactly for resolution.
- segment typed paths on `/` or `\\` to compute display roots.
- split a typed Fabric ref once on `.` to expose provider/action identity.
- inspect the explicit typed `created: true` result field for write classification.
- decode the exact typed Fabric request prefix with a bounded structural JSON parser.

The core never recovers command prefixes, stdout/stderr line formats, error
wording, path-looking prose, commit-looking prose, source code, or tool-result
renderings into semantic facts.

## Custom instructions

Plain custom instructions are always explicit user data; Fabric never treats a reserved text sentinel as routing control.

Fabric treats every other plain instruction as explicit user data. It
canonicalizes whitespace, bounds the input, and includes the text in
`[Compaction Request]` without semantically parsing it.

`compact.request` may add typed `preserve: string[]` values. When present, the
controller forwards an exact versioned prefix followed by JSON. The hook
accepts only the exact prefix and a strict v1 object. Once that reserved
prefix is present, malformed JSON or scalars, duplicate protocol keys
(including escaped-key aliases), unknown fields or versions, invalid types,
unpaired UTF-16 surrogates, excessive structure, or exceeded bounds produce a
structured decode error and cancel the operation. Fabric never reinterprets or
renders the encoded payload as plain instructions. A UI/RPC context receives a
bounded error notification when available.

Fabric enforces the typed v1 limits before value mapping or canonicalization.
Instructions cap at 8192 characters and 8192 UTF-8 bytes. The `preserve` list
holds at most 16 items, and each item caps at 2048 characters and 2048 UTF-8
bytes. The complete prefix-plus-JSON source must fit within 16 KiB. The
decoder checks the aggregate source limit before invoking its bounded
recursive-descent parser. While parsing, it rejects duplicate decoded keys and
validates scalar grammar and surrogate pairing. It checks the preserve count
before it iterates or canonicalizes values. Plain OMP and manual instructions
stay explicit bounded text and never run through the typed protocol parser.

## Compaction details v2

New summaries emit `details.compactor: "fabric"` and `details.version: 2` with:

- cumulative source and live-cut ranges.
- branch, source-entry, event, and live-cut counts.
- prior recognized Fabric v1/v2 marker counts.
- per-projection omission counts, the typed preserve count (valid v1 requests cannot exceed the preserve limit), and the structural count of erased assistant thinking blocks.
- instruction mode, canonicalization, source size, truncation, and preserve counts.
- stable kept/source entry-id addresses and the source timestamp.
- when continuity budgeting is active: effective window, occupancy ceiling ratio/tokens, continuity target, reserve and reduction ceilings, the binding constraint, OMP reserve/recent settings, raw estimate, calibration scale, fixed overhead, raw-tail budget, retained raw tokens, and Fabric's `projectedTokensAfter`. OMP core independently recomputes its own `estimatedTokensAfter` after persisting the compaction. Legacy v2 records with `strategy: "adaptive"` remain recognized.

Fabric recognizes exact versions 1 and 2 only. v1 details and rendered prose
never serve as truth. An old session migrates to v2 on the next compaction,
because Fabric rebuilds the new result from raw active-branch entries. V2
validation accepts the legacy commit-omission counter for old records. New
summaries drop the commit projection and its counter.

## Nested Fabric execution traces

For an outer `fabric_exec` tool result, normalization pairs the result with
its assistant call by exact `toolCallId`. When that call has a non-empty typed
`display.name`, Fabric emits a declared-intent record with an internal
`call-entry-id/call:toolCallId` fact address. Fabric also exposes the
assistant call entry ID for exact raw-source expansion, or that fact address
after branch rehydration. Fabric bounds the name to 256 UTF-8 bytes and the
optional description to 1024 bytes, and the outcome comes from a valid
aggregate trace outcome or the outer typed `isError` flag when no aggregate
exists. Fabric
never treats this metadata as proof of work. The paired outcome and nested
operations remain the authoritative evidence. Normalization reads nested
execution only from `message.details.trace` through
`readFabricExecutionTraceV1`. Emitted operations follow `operation.sequence`
order with addresses such as `entry-id/0`, and phases use `entry-id/phase:0`.
Known `omp.read`, `omp.grep`, `omp.find`, `omp.ls`, `omp.edit`, `omp.write`, and
`omp.bash` and `` calls retain exact typed arguments and outcomes. Other refs remain
typed Fabric activity.

Fabric ignores a present trace version when it is malformed or unknown. It
never reinterprets such a trace as legacy data. When `trace` is absent, the
legacy adapter accepts only an audit array whose records have typed `ref`, JSON
`args`, boolean `success`, and optional string `error`. The adapter never
reads audit rendering or `result` prose. An unnamed outer tool conversation
remains generic in the transcript. A completed named run replaces that generic
call/result pair with its bounded name and outcome. `fabric_exec` source code
and outer result prose still cannot create file, failure, or activity facts.

## Deterministic branch summaries

When the Fabric engine is active, the same registration also handles
`session_before_tree`. The handler returns nothing when `userWantsSummary` is
false, and it compiles only `preparation.entriesToSummarize` when true. Tree
custom instructions use the same plain/typed decoder and fail-closed limits as
compaction. Plain instructions remain ordinary explicit request text on the tree path.

`replaceInstructions: true` follows OMP replacement-prompt semantics. A
deterministic projection cannot execute an arbitrary replacement summarizer
prompt, so Fabric returns `undefined` and defers to OMP or another handler.
Fabric produces no summary and no typed Fabric branch details in that explicit
mode.

Branch details use `kind: "omp-fabric.branch-summary"`, current `version: 2`,
stable source addresses, and at most 256 bounded typed facts in a 128 KiB
envelope. Facts cover source users, top-level custom messages, named Fabric
runs, phases, and operations. V2 adds bounded `fabricRun` facts that carry the
declared name and description with the paired outcome. Strict v1 envelopes
remain readable, and Fabric never reinterprets them as v2. Newly generated
details record `source.oldLeafId` from `preparation.oldLeafId`, which is the
canonical abandoned/from-leaf provenance. Older v1 envelopes without that
field remain readable. The OMP host writes the generic `BranchSummaryEntry.fromId`
from the navigation target position, and that position differs from the
abandoned leaf. A hook cannot correct that core-generated field, so consumers
must use Fabric's typed `source.oldLeafId` when present.

Nested branch summaries re-emit only valid typed facts, and normalization
never reads branch summary prose. Later compaction can then resolve
abandoned-branch failures against later exact successes, and custom context, files, and
activity survive navigation or forks without any prose parsing. OMP supplies
only the active path or the abandoned `entriesToSummarize` path to each
compiler, so sibling branches cannot contaminate one another.

## OMP compaction precedence

Precedence remains:

1. the configured compaction engine;
2. OMP's native compaction behavior when the engine is `"omp"`;
3. Fabric's deterministic summary when the engine is `"fabric"`.

Fabric marks claimed events with `_fabricCompaction`. OMP's public extension contract runs `session_before_*` handlers in extension load order and keeps the latest non-cancelling result. An unrelated handler loaded after Fabric can replace Fabric's compaction or tree result. A later cancellation terminates dispatch. Fabric never monkeypatches OMP's private runner.

## Reconstruction QA

`src/compaction/qa.ts` derives probes from normalized source events, never
from rendered sections. QA probes follow the same bounded sampling policy as
projections. The report checks directly rendered samples for content, and it
validates omitted collections for count and range addressability. Mutation tests
remove file, error, turn, latest Fabric run intent/outcome/address, and footer
information to verify that the report detects loss.

Run:

```sh
bun vitest run tests/compaction-qa.test.ts
```
