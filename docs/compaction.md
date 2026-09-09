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

## Summary maintenance

The dedicated model is selected from `compaction.summaryModel` through OMP's public model registry and session-aware resolver. Pick it in `/fabric settings` under Compaction > Summary model, which lists the models OMP has available and offers Inherit to fall back to the active session model. The runtime resolves compaction options at use time, so a change applies to the next maintenance pass and the next compaction without restarting the session. The active session model is the fallback when the dedicated route is unavailable. Leaf and condensed prompts XML-fence transcript evidence and treat it as untrusted data.

Maintenance defaults are bounded to 32 model calls, 2,000,000 input tokens, and 128,000 output tokens per project per UTC day, with a nested 16-call session limit. One project model job runs at a time. Jobs use 30-second leases renewed every 10 seconds, 60-second call limits, exponential retry backoff capped at 15 minutes, and three attempts. A failed call does not publish a ready node or increment usage counters.

The emergency reducer is deterministic, explicitly nonsemantic, source-addressed, and bounded to 4,096 bytes by UTF-8 size. Provider failure keeps raw entries and pending maintenance recoverable.

## Retrieval

Use the existing namespaced memory actions:

- `memory.recall` returns bounded raw and summary hits. The default LCM scope is the current session when one is bound; explicit session scope remains available. Active-branch results require source references on the live branch. Incomplete or stale coverage is reported and never treated as an authoritative no-match.
- `memory.expand` follows a stable raw or summary reference. Raw expansion returns the exact structured `SessionEntry` payload, including tool arguments, tool results, custom details, and media fields. Summary expansion returns the summary text and its structured source references.
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
    "lcmMaxInputChars": 48000,
    "lcmMaxOutputTokens": 4096,
    "lcmMaxOutputChars": 16384,
    "lcmMaxLeafEntries": 8,
    "lcmMaxCondenseChildren": 4,
    "lcmMaintenancePasses": 8,
    "lcmMaxDailyModelCalls": 512,
    "lcmMaxSessionModelCalls": 256,
    "lcmMaxDailyModelSeconds": 7200
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

## Maintenance throughput

Maintenance runs after a turn settles and on session compaction; the hook itself never calls a model. Each run makes at most `compaction.lcmMaintenancePasses` passes bounded by a 60-second run guard, and a pass packs unconsumed raw entries into one leaf until either `compaction.lcmMaxLeafEntries` or the `compaction.lcmMaxInputChars` prompt budget is reached, so a leaf never clips its own evidence. A session that ingests more entries per turn than that leaves a growing unsummarized tail, and a compaction whose source range reaches into that tail falls back to the deterministic emergency reducer, carrying an excerpt in place of model summaries.

Raise `lcmMaintenancePasses` (1-64) to trade model spend for coverage. `lcmMaxDailyModelCalls`, `lcmMaxSessionModelCalls`, and `lcmMaxDailyModelSeconds` bound the model spend itself; a session that exhausts them keeps working and writes deterministic excerpts until the next day. It is separate from `lcmMaxCondenseChildren`, which is the condensation fan-in: how many ready nodes are folded into one condensed parent. The daily project and per-session call, token, cost, and wall-time budgets still bound every run.

## Performance gate

`bun run benchmark:lcm` drives the fixed fixture from the LCM operational contract: 10 sessions of 1,000 raw entries at 1 KiB each, 20 compaction cycles through the built `session_before_compact` hook, a repeat pass that must reuse the ready frontier, and a second process appending to the same ledger. It fails when a row is lost or duplicated, when a node references an uncommitted source or child, when the hook issues any model call, when hook p95 exceeds 250 ms, when recall precision or exact expansion regresses, or when a restart loses rows or nodes. The run prints and writes a JSON report covering ingest throughput, hook latency percentiles for both the emergency and ready-frontier paths, maintenance backlog, recall and expansion latency, migration counts, database and WAL bytes, checkpoint outcomes, and lock errors observed by the competing process:

```sh
bun run benchmark:lcm -- --out lcm-report.json
```
