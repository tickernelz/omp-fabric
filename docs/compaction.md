# LCM compaction

OMP Fabric uses LCM as its default compaction engine. Set `compaction.engine` to `"omp"` only when OMP's native compaction should own the session.

## Model-visible context

LCM assembles one bounded OMP compaction result from:

- ready summary-frontier nodes;
- a protected fresh tail selected by OMP's `firstKeptEntryId` preparation;
- bounded source and lineage metadata.

The hook uses the standard `session_before_compact` contract. It reads committed nodes and produces a valid `CompactionResult`; it does not call or await a summarization model. When semantic maintenance has not produced a ready node, the hook emits a bounded deterministic emergency excerpt with explicit source references.

## Durable storage

LCM stores the complete authoritative OMP `SessionEntry` as canonical UTF-8 JSON in a project-scoped SQLite ledger outside the working tree. Object keys are recursively sorted before hashing. The ledger retains raw entries indefinitely by default and never deletes them during compaction.

Each summary node is immutable after publication of its source identity. Leaf nodes cover bounded raw-entry ranges. Condensed nodes cover completed child nodes. Every source reference carries the session, entry ID, revision, and payload hash. Node, edge, frontier, and maintenance-job publication is transactional.

SQLite uses WAL, `synchronous=FULL`, a serialized writer, a 5-second busy timeout, and startup integrity verification. Project storage uses canonical recorded cwd/realpath identity with device/inode preference when available. Symlink aliases and renames converge; distinct worktrees remain distinct projects.

## Lifecycle

`message_end` is only a dirty-session hint because OMP emits a detached message before native persistence. LCM assigns authoritative identity from post-persistence session readback:

1. `session_start` reconciles only the selected `getSessionFile()`; unrelated sessions are not scanned.
2. `agent_end` and `session_compact` read the stable active branch and append complete entries idempotently.
3. Background maintenance claims leaf and condensation jobs with durable leases and bounded retries.
4. A later compaction hook reads ready nodes without waiting for maintenance.
5. `session_shutdown` aborts model work, drains writes, and closes the ledger.

The selected-session reconciler stores a source generation/checkpoint and resumes after interruption. It does not perform a global three-day migration. The old bulk migration command is not part of normal operation.

Reconciling the live session reads a file the session itself is writing. A read the writer moves under the reader is counted as `raced` and retried up to three times; only a settled read is scanned. A raced read is never counted as an error, and the panel names how many reads were retried. A source that never settles within those attempts is reported as incomplete discovery. An unreadable source, a project-key mismatch, and a dropped entry stay errors and drops.

A reconciliation fault recorded at startup would otherwise last the whole session, because reconciliation runs once at session selection. While the record holds an error, the next three turn boundaries re-run the same reconciliation after readback. A clean pass replaces the record and clears the message; a fault that is still true is recorded again at the same volume. Drops are facts about content already read, so a later pass leaves them standing.

## Summary maintenance

The dedicated model is selected from `compaction.summaryModel` through OMP's public model registry and session-aware resolver. Pick it in `/fabric settings` under Compaction > Summary model, which lists the models OMP has available and offers Inherit to fall back to the active session model. The runtime resolves compaction options at use time, so a change applies to the next maintenance pass and the next compaction without restarting the session. The active session model is the fallback when the dedicated route is unavailable. Leaf and condensed prompts XML-fence transcript evidence and treat it as untrusted data.

Maintenance defaults are bounded to 32 model calls, 2,000,000 input tokens, and 128,000 output tokens per project per UTC day, with a nested 16-call session limit. Up to `compaction.lcmMaintenanceConcurrency` model jobs hold a lease at once, 3 by default. Jobs use 30-second leases renewed every 10 seconds and reclaimed 60 seconds after a lease lapses, 60-second call limits, exponential retry backoff capped at 15 minutes, and three attempts. A claim refused because the cap is full or the budget is spent leaves the job pending and costs it no attempt. A job that a release before 1.13.2 retired on such a refusal returns to pending with its attempts cleared on one maintenance pass, once per job for the life of the ledger. The synchronous claim a compaction makes when no ready frontier covers its range takes a lapsed lease at 30 seconds without waiting for the reclaim grace, and when a live worker holds the lease it serves the deterministic excerpt and leaves the node alone. A failed call does not publish a ready node or increment usage counters.

The emergency reducer is deterministic, explicitly nonsemantic, source-addressed, and bounded to 4,096 bytes by UTF-8 size. Provider failure keeps raw entries and pending maintenance recoverable.

## Retrieval

Use the existing namespaced memory actions:

- `memory.recall` returns bounded raw and summary hits. The default LCM scope is the current session when one is bound; explicit session scope remains available. Active-branch results require source references on the live branch. Incomplete or stale coverage is reported and never treated as an authoritative no-match.
- `memory.expand` follows a stable raw or summary reference. Raw expansion returns the exact structured `SessionEntry` payload, including tool arguments, tool results, custom details, and media fields. Summary expansion descends one level: it returns the constituent messages the summary was built from, each with its own address and a `memory.expand` follow-up, or the child nodes of a condensed node. The node's own text, kind, state, sources, and children sit in a top-level `node` field.
- `memory.sessions` remains the session inventory action.

Summary text is a navigation aid. Exact action or factual claims should be checked against expanded raw source entries.

## Tree and handoff behavior

LCM uses the standard `session_before_tree` hook when the user requests a branch summary. The result contains bounded typed branch facts and the abandoned `oldLeafId`; sibling branch prose is not used as source truth.

Trajectory handoff compaction has no live `ExtensionContext`, so it uses the LCM deterministic emergency reducer over the discarded prefix, keeps the latest user boundary when one exists, and records source range metadata. It does not invoke the old Fabric compiler or a hidden model call.

## Operational controls

Raw retention is indefinite but bounded operationally:

- 8 GiB per project: warning in status and UI when available;
- 10 GiB per project: stop new model-maintenance claims while preserving raw appends;
- ENOSPC: durable degraded state; no successful skip is reported;
- backup/export: mode-0600 `VACUUM INTO` copy with SHA-256, row counts, and integrity manifest;
- deletion: explicit typed project confirmation, verified backup, transactional scoped delete, post-delete integrity check, and audit manifest.

Automatic raw deletion is disabled.

## Configuration

```json
{
  "compaction": {
    "engine": "lcm",
    "summaryModel": "provider/model",
    "targetContextRatio": 0.75,
    "softThresholdRatio": 0.55,
    "hardThresholdRatio": 0,
    "lcmMaxInputChars": 48000,
    "lcmMaxOutputTokens": 4096,
    "lcmMaxOutputChars": 16384,
    "lcmMaxLeafEntries": 8,
    "lcmMaxCondenseChildren": 4,
    "lcmMaintenancePasses": 8,
    "lcmMaintenanceConcurrency": 3,
    "lcmModelSummaries": true,
    "lcmModelTimeoutSeconds": 120,
    "lcmMaxDailyModelCalls": 0,
    "lcmMaxSessionModelCalls": 0,
    "lcmMaxDailyModelSeconds": 0
  }
}
```

Legacy persisted `compaction.engine: "fabric"` is migrated to `"lcm"` by the config migration. Unknown engine values normalize to the LCM default. OMP native delegation remains the explicit `"omp"` value.

## Verification

Focused LCM tests cover ledger durability, canonical payload identity, branch isolation, model budgets, emergency bounds, on-demand session reconciliation, memory provider routing, tree summaries, and handoff continuity. Run:

```sh
bun run check
```

This command includes typecheck, a fresh `dist/` build, the lazy-graph assertion, the full test suite, and dead-code lint.

## Occupancy thresholds

`softThresholdRatio` is a floor that forces maintenance, not the permission to run it. A pass is due when the active branch carries at least `lcmMaxLeafEntries` uncovered entries, when a claimable job for that branch is waiting, or when context occupancy reaches this ratio. The first two build the summary DAG ahead of need, at any occupancy; the ratio adds the last sweep, so the tail below one leaf is covered before a compaction asks for it. When `getContextUsage()` is missing or reports an unknown percentage the floor counts as reached, so a missing reading never silently disables LCM. At `0` every sync reaches the floor and maintenance runs at any occupancy; both ratio keys use the same `0`-is-off convention. Persistence and bookkeeping are never gated at all: every `agent_end` and `session_compact` reads the session branch back into the ledger and reclaims the jobs whose owner died, whatever the occupancy is. A configured daily or per-session model budget is the ceiling: once it is exhausted no pass is scheduled, so the cap stops spend without burning job attempts.

`hardThresholdRatio` is the blocking trigger and is disabled at `0`. A model listed in `thresholds` or `tokenThresholds` uses its own entry; every other model falls back to this ratio when it is above `0`. Normalization keeps an enabled soft ratio strictly below an enabled hard ratio, and rounds the ratio it derives to the 0.05 grid `/fabric settings` offers, so a reconciled value is always selectable there.

## Addressed summaries

Every summary a compaction serves carries engine-derived addresses beneath each node's text: `address: lcm.summary:<nodeId>` for the node itself, then `sources: lcm.raw:<session>:<entry>:<revision>` for the raw entries it covers, or `children: lcm.summary:<nodeId>` for a condensed node. These are the exact forms `memory.expand` parses, so a model reading a summary can always retrieve what was summarized. They are appended after the frontier walk from ledger data and are never taken from model output. When the summary budget is reached, whole node blocks are dropped from the tail, never a cut through the middle of one, so a node is either rendered complete with its own address or withheld and named. A block too large to fit whole is skipped on its own and the blocks behind it still render; only when no block fits whole does the render clip the largest one, and that clip's `…` marker sits inside the block text, above its `address:` line. The withheld notice names what was dropped: `… withheld N frontier nodes that did not fit; expand: lcm.summary:<id>`, listing the addresses it withheld and appending `, +K more` when even that list must truncate. An address list is emitted only when it fits whole, so `sources:` and `children:` lines are never half-written.

The tail order is fixed: block text, the block's `address:` line, its `sources:` or `children:` lines, then the withheld notice when one is needed, then the recovery pointer. Every non-empty render closes on exactly one recovery pointer line, and a withheld notice sits directly above that pointer with a blank line between them. The render is empty only when no frontier node carries text at all. Every node stays reachable through `memory.expand`; before this, a frontier past 32 KiB lost both the trailing addresses and the pointer.

## Maintenance throughput

Maintenance runs after a turn settles and on session compaction, whenever a pass is due; the hook itself never calls a model. Each run makes at most `compaction.lcmMaintenancePasses` passes bounded by a 60-second run guard, and a pass packs unconsumed raw entries into one leaf until either `compaction.lcmMaxLeafEntries` or the `compaction.lcmMaxInputChars` prompt budget is reached, so a leaf never clips its own evidence. A session that ingests more entries per turn than that leaves a growing unsummarized tail, and a compaction whose source range reaches into that tail falls back to the deterministic emergency reducer, carrying an excerpt in place of model summaries.

Raise `lcmMaintenancePasses` (1-64) for more leaves per turn. `lcmMaintenanceConcurrency` (1-8, 3 by default) is how many summary calls one run keeps in flight, and it decides how much of a backlog a single 60-second run can clear. Measured against an 8-job session backlog at 15 seconds per call, a run cleared 4 jobs per turn at 1, and all 8 in one turn at 2 and at 3. Spend per turn scales with the same number, so 3 costs up to three times what 1 costs over the same wall time. A job whose call outlives the run deadline holds its slot until it returns; the deadline stops new dispatch and never abandons work already paid for. Model spend carries no limit by default: `lcmMaxDailyModelCalls`, `lcmMaxSessionModelCalls`, and `lcmMaxDailyModelSeconds` are 0, which means no cap, and setting any of them applies that cap. A summary call is abandoned after `lcmModelTimeoutSeconds` (120 by default, 10 to 900). A deterministic excerpt is written when the summary model cannot be called, when it overruns that deadline, or when `lcmModelSummaries` is false, and maintenance replaces such a node with a model summary once the model answers again. It is separate from `lcmMaxCondenseChildren`, which is the condensation fan-in: how many ready nodes are folded into one condensed parent. The daily project and per-session call, token, cost, and wall-time budgets still bound every run. A claim reserves one call for itself and one for every live sibling lease, so admitted calls stay inside the daily and session call caps. For the token, cost, and wall-time caps it reserves the average consumption per call recorded today. Two cases pay for a call that will be refused: the first calls of a day, where nothing is recorded and the average reserves zero, so the batch is admitted on recorded usage alone, and a call heavier than the recorded mean, which the average understates. In both the call is made, completion refuses its result, and the range falls back to the deterministic excerpt. Recorded usage never passes a cap, because completion re-checks every dimension and refuses a result that would cross it. A lease counts against the cap and against those reservations until 60 seconds after it lapses, the moment the sweep hands its slot back. A worker whose process stalls through the full 90 seconds of lease and reclaim window keeps its call running after its slot is handed on, and its result is refused when it returns: the call is paid for, no usage is recorded, and the job keeps its attempt count. Concurrent calls pass the cap by the number of stalled workers.

## Inspecting a live ledger

`/fabric status` carries one LCM line: operational state, summary model, entry count, how many ready nodes the model wrote against how many exist, and today's calls and model seconds against their budget.

The report carries one reconciled `state` that already accounts for any runtime fault, so a surface that prints it can never place `healthy` beside a fault message. `ledgerState` keeps the ledger's own word, and both renderers print `degraded (ledger healthy)` when the store is intact while the runtime holds a fault. A third surface that prints `state` alone stays truthful without repeating the reconciliation.

Every compaction key appears in `/fabric settings` under Compaction. `/fabric dashboard` carries the ledger on key `3`: the coverage band for the active branch, the node graph paged by depth, the text a compaction would serve right now beside the session payload it draws from, and a node detail that opens the exact stored raw entry behind any source. A node replaced by a model summary keeps its previous text, so an excerpt and the summary that superseded it sit side by side. The reads happen once per refresh; nothing in the render path touches the ledger.

## Performance gate

`bun run benchmark:lcm` drives the fixed fixture from the LCM operational contract: 10 sessions of 1,000 raw entries at 1 KiB each, 20 compaction cycles through the built `session_before_compact` hook, a repeat pass that must reuse the ready frontier, and a second process appending to the same ledger. It fails when a row is lost or duplicated, when a node references an uncommitted source or child, when the hook issues any model call, when hook p95 exceeds 250 ms, when recall precision or exact expansion regresses, or when a restart loses rows or nodes. The run prints and writes a JSON report covering ingest throughput, hook latency percentiles for both the emergency and ready-frontier paths, maintenance backlog, recall and expansion latency, migration counts, database and WAL bytes, checkpoint outcomes, and lock errors observed by the competing process:

```sh
bun run benchmark:lcm -- --out lcm-report.json
```
