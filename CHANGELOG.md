# Changelog

## 1.18.0

### Fixed

- A forked session no longer starts with an empty frontier. LCM identified a source by `sessionId:entryId:revision`, and a fork mints a new session id while keeping the entries it inherited, so every summary the parent built fell out of the fork on its first readback. A source is now identified by its entry id and payload hash, and the live source set decides membership instead of the session id. Measured on a production ledger, a 400-entry branch that covered 160 sources keeps all 160 after the fork; it covered 0 before.
- `memory.recall` and `memory.expand` accept an inherited summary and its raw sources. The active-branch binding resolved by session id, so a fork was served summaries whose addresses it then refused to open.
- A summary the parent left pending no longer suppresses the fork's own leaf over the same entries, which previously dropped up to one leaf window from coverage until the parent session was resumed.

### Changed

- `LcmLedger.readRawKeys` returns `contentHash` alongside each key so the coverage map builds the same identity the frontier uses.

## 1.17.0

### Fixed

- Summaries stopped leaving the frontier one message after they were built. LCM stamped each stored entry with the host's leaf id, which is the id of the newest entry, and then filtered the frontier on it, so a node matched only until the next message arrived. The label is gone from the model: `LcmNode` no longer carries it, leaf and condensed identity no longer hash it, and the four selectors no longer filter on it. A production ledger of 5,400 entries held 106 of 133 nodes behind 36 dead leaf values and served 2 of 400 sources; the same branch now serves 160 of 400. Existing ledgers keep the labels in a column nothing reads, so nothing migrates.
- Branch isolation now rests where it was already exact: a summary is served only when every source it covers is on the live branch. `selectLeaf` applies that same predicate when it decides which entries are already summarised, so an entry covered only by a node the live branch cannot serve is summarised again instead of being skipped forever.
- `getFrontier` drops a node whose sources another selected node fully contains, so a rewind that remints a covered prefix can no longer put the same range into a compacted prompt twice.

### Changed

- `branch` was removed from `LcmCompactionInput`, `LcmCompactionOutput`, `LcmSummaryNode`, `LcmDashboardNode` and the memory branch binding. `createLeaf` and `createCondensed` now require their arguments rather than defaulting to an unscoped selection.

## 1.16.0

### Added

- `/fabric lcm` opens a dashboard of its own for the LCM ledger, with four tabs: `health` runs a doctor over seven checks and offers a one-key repair for the ones that carry one, `graph` pages the summary nodes and opens the raw entry behind any source, `coverage` draws every stored branch entry as one aggregated cell above the text a compaction would serve, and `jobs` lists maintenance work failure-first with `r` to requeue and `l` to release stuck leases.
- An automatic repair ladder persisted in the ledger (`repair_ladder`): one repair per turn boundary, a failing check preferred over a warning one, five attempts per fault class with 30-second backoff doubling to 8 minutes, parked and reported once the budget is spent, and cleared after its check has been quiet for half an hour.
- A ledger directory (`projects.json`) that remembers the key each project path was first filed under, so a project whose directory changes inode keeps its history, plus a daily sweep that removes a ledger only when its project directory is gone and nothing has written it for 30 days.

### Fixed

- A session file the host has not written yet is reported as absent rather than as a reconciliation error, so a fresh session no longer opens `degraded` with a fault it cannot act on. Reconciliation re-runs once the file appears.
- Readback hashes each branch entry and appends only the ones whose payload is not stored yet, which lets it run on every message instead of once a turn; an entry amended in place still gains a revision.
- The frontier cache is invalidated whenever readback, reconciliation, maintenance, compaction, or a repair changes what it summarises, so coverage can no longer report a stale figure.
- The jobs page orders failures first in SQL, so a recent failure is visible on a ledger holding more jobs than one page.
- `BACKUP_MANIFEST_VERSION` moves to 3 because the ledger snapshot now digests the repair table; an older backup is refused with the versioned message instead of a raw SQLite error.

### Changed

- The LCM view left the shared `/fabric dashboard`; key `3` is gone and the help screen points at `/fabric lcm`.

## 1.15.0

### Added

- Support for compaction custom instructions and preserve items in LCM: `renderAddressedFrontier` and `emergencyReduce` now render a `[Compaction Request]` block when instructions or preserve entries are supplied via `compact.request`, matching the deterministic compactor's policy contract.
- SQLite indexes on `summary_nodes(project_key, created_at, node_id)`, `maintenance_jobs(project_key, status)`, and `summary_edges(child_id, parent_id)` to eliminate unindexed table scans during node listing, job scheduling, and ancestor edge traversal.
- Warning logging and UI notifications on compaction hook errors before cancellation, preventing silent context blowups.

### Fixed

- Transaction batching during session readback and compaction: `readback()` and `compact()` now wrap raw entry persistence in an explicit ledger transaction, collapsing hundreds of sequential synchronous SQLite fsync operations into a single atomic commit.
- Dirty flag enforcement in `LcmRuntime`: `syncAndSchedule()` now checks `this.dirty` and active session binding to skip redundant full-branch readbacks on idle turns.
- Memory allocation in `clipUtf8End`: trailing text slices are now bounded to `maxBytes * 2` before codepoint conversion, eliminating multi-megabyte array allocations when producing emergency excerpts.

## 1.14.0

### Added

- `compaction.lcmMaintenanceConcurrency` (default 3, clamped to 1-8, editable under **Compaction → Maintenance concurrency**) is how many summary jobs one maintenance run holds a lease on at once. Maintenance ran one job at a time before this, so the default multiplies the spend rate of a run by three over the same wall time; `lcmMaxDailyModelCalls`, `lcmMaxSessionModelCalls` and `lcmMaxDailyModelSeconds` stay the ceiling. Measured against an 8-job session backlog at 15 seconds per call, a run cleared 4 jobs per turn at 1 and all 8 in one turn at 2 and at 3.

### Fixed

- A lapsed lease no longer drops out of the concurrency count and the budget reservation while its call is still running. The claim counted a lease as live only while `leaseUntil` was in the future, and the sweep returned the slot 60 seconds later, so a job in that gap was reserved for by nothing. Measured with a fake clock at cap 3 against a 4-call budget: three claims, a correct refusal of the fourth, then 31 seconds of clock advance admitted two more claims for five concurrent calls at a cap of 3, and the budget check reported room with three unrecorded calls outstanding. A claim, a steal, and the claimable-job query now all treat a lease as held until 60 seconds after it lapses, the moment the sweep hands the slot back.
- A claim refused for contention no longer spends one of a job's three attempts. `dispatch` sized its worker pool once while `claim` re-read the live setting, so lowering the concurrency mid-run left surplus workers refused with `project lease held`, and the catch could not tell a refusal from a model failure. Measured through the runtime with 8 jobs at concurrency 3 lowered to 1, 4 of the 8 carried an attempt they never earned; three such runs retire a job to `failed`, where the sweep and the scheduler both skip it and its range falls back to the emergency excerpt for the life of the project. A refusal now carries its reason, a surplus worker retires before it takes a job, and a refused claim leaves the job pending with its attempt count and the runtime's health untouched. The single-job cap of 1.13.1 and earlier threw the same refusal at a second process working the same project, so a ledger written before this release can hold jobs retired that way. One maintenance pass returns such a job to pending with its attempts cleared and marks it, so no later pass can take it a second time.
- Recovering a job an older ledger retired for contention no longer masks a real fault. The recovery matched any of the five refusal reasons under any `Word: ` prefix, so it also took a job retired on a genuine `budget exhausted` failure, the exact text completion throws when a real cap is crossed, and one retired on a provider `AbortError: job not eligible`. Once matched a job never stayed retired: five rounds of three real failures produced five recoveries with attempts cleared each time, so a permanently broken job cycled and its fault never surfaced. This release cannot write a refusal into a job's error at all, since `run` rethrows a fence, the dispatcher filters refusals before it records a failure, and `fail` is lease fenced. The rule is what it always was, a migration for ledgers written before 1.13.2, and it now reads as one: it takes only the two exact strings the older code wrote for a contention refusal, `LcmRejection: job lease held` and `LcmRejection: project lease held`, it consumes that error when it acts, and it marks the job so a second recovery needs a second ledger.
- A hard-threshold compaction is no longer cancelled by a lease its own last-resort claim could not take. `claimEmergency` inherited the 60-second reclaim grace from the ordinary claim, so a lease left by a dead worker refused it for 90 seconds: measured, refused at 30 seconds and one millisecond, admitted only at 90 seconds. The compaction hook turns a throw from `compact` into a cancellation with no summary and no notification, so that window silently cancelled compactions for three times as long. The emergency claim ignores the concurrency cap and the budget already, and the reclaim grace exists to hold a slot for the reservation those two read, so it now takes a lapsed lease at 30 seconds. A refusal it can still meet, a lease a live worker holds, returns the deterministic excerpt it had already built and leaves the node to the lease holder.
- The lease sweep no longer carries a window a caller can drop. Its grace was a parameter defaulting to `0`, and a sweep at grace `0` returns a running job to pending while its call is live, which drops it out of the live-lease query and reopens the reservation hole. The grace is now the constant every other member of that predicate reads, with no way to pass another.
- A completion fenced by a stalled lease no longer retires the job. Every lease of a fan-out batch lapses together, so one stall charged an attempt to all of them at once. The work may well have succeeded and only the bookkeeping was refused, so a fence is now reported as a fence: nothing is recorded, the node is left for whoever holds the lease next, and the attempt count stays where it was.
- The token, cost, and wall-time budgets reserve for a call before it is made. Those three dimensions were tested against recorded usage with nothing reserved, so with 350 input tokens of headroom at 100 tokens per call, 9 jobs were admitted; every call past the third was paid for and refused at completion, which left the recorded total below the cap and admitted the next job on the same reasoning. A claim now reserves the average consumption per call recorded today for itself and for every live sibling lease. Two cases still pay for a call that will be refused: the first calls of a UTC day, where nothing is recorded and the average reserves zero, and a call heavier than today's recorded mean, which the average understates. In both the call is made, completion refuses its result against the exact cap, and the range falls back to the deterministic excerpt with no usage recorded.

### Changed

- The documented concurrency bound is the bound the code holds. `docs/compaction.md` carried both "One project model job runs at a time" and the new concurrency sentence, and it generalized the call reservation to every budget dimension. It now states what is enforced: leases at once never pass the setting, calls and per-dimension averages are reserved per live lease, a lease is reserved for until 60 seconds after it lapses, and a process stalled through the full 90 seconds of lease and reclaim window can push concurrent calls past the cap with its own result refused. It also names the two cases where a reserved-average claim pays for a refused call, the once-per-job bound on recovering an older ledger's contention retirements, and the 30-second window the compaction's own last-resort claim uses.

## 1.13.1

### Fixed

- The status line no longer reads `healthy` beside a fault. `state` described the ledger file and the fault message described the runtime, and printing them side by side produced `lcm · healthy · … · degraded: …`. The report now carries one reconciled status, with the ledger's own word kept separately, so a renderer added later is correct without repeating the reconciliation. When the two facts differ the line says `degraded (ledger healthy)`.
- Reconciling the live session's own file while that file is being appended is counted as a raced read and retried, no longer as an error. The reader validates the file size before and after, and a session writing its own transcript trips that check by construction. A source that never settles is reported as incomplete discovery. An unreadable file, a cross-project mismatch and a dropped entry are all still counted and surfaced exactly as before.
- A reconciliation fault no longer outlives its cause. It was recorded once at session selection, and with a single call site nothing revisited it, so one momentary race pinned the message for the rest of the session. While an error is outstanding the runtime re-runs the same check at the turn boundary, at most three times per session, and only a clean pass replaces the record.
- Long lines wrap on every tool surface. 1.13.0 fixed the multicall renderer; the single-call and settled-result surfaces in `fabric-exec-tool.ts` kept clipping, one of them because wrapping was tied to whether the call happened to produce agent preview lines. That flag was tracked to the commit that introduced it and protected nothing. Wrapping is now the default in `BoundedLineList` and cannot be omitted at a call site; the row limit is the only knob. Nine call sites across two files were audited, and the four that could clip user-visible content now wrap.

## 1.13.0

### Fixed

- LCM maintenance runs when there is work, so the summary DAG exists before a compaction needs it. 1.12.0 gated maintenance on context occupancy reaching `compaction.softThresholdRatio`, but compaction serves a precomputed frontier and itself pushes occupancy back down, so a real project could sit below the threshold indefinitely while its backlog grew. Measured on a live ledger across a turn boundary: entries rose from 10,001 to 10,005 while pending jobs stayed at 96, completed stayed at 84 and zero model calls were made. A pass is now due when the active branch carries a leaf's worth of uncovered entries, when a claimable job for that branch is waiting, or when occupancy reaches the ratio. The daily and per-session model budgets are the ceiling: an exhausted budget schedules no pass at all, which also stops an exhausted budget from burning a job's attempts until it retires.
- A maintenance job whose owner died is reclaimed whatever the occupancy. The sweep sat inside the gated pass, so on a project below the threshold a dead lease was stranded forever; the live ledger carried nine, expired between ten and eighteen hours earlier.
- Long tool rows wrap in the compact display. They were clipped at the right edge with no marker, so the end of a command or an error was simply gone. Compact rows wrap to three rows and say ` …+N` when more was dropped; expanded output is unchanged. The header, the phase row, a failed call's error text and the hidden-calls line were never wrappable in either mode and now are.

### Changed

- `compaction.softThresholdRatio` is a floor that forces a maintenance pass, no longer the permission to run one. Maintenance also runs on its own backlog, so the ratio now covers the tail below one leaf before a compaction asks for it. The `0`-is-off convention, the fail-open on an unreadable occupancy reading, and the clamp range are unchanged.

## 1.12.0

### Fixed

- LCM stopped summarizing once a project passed 100 finished maintenance jobs, and said it was healthy while it did. The scheduler read its queue through a generic oldest-first page capped at 100 rows, completed jobs are never pruned, and every pending job eventually fell outside that page; the guarded call that would have run them did nothing, and the surrounding catch discarded the reason, so stranded jobs kept attempts 0 and error null. On the ledger that surfaced this: 146 jobs, a page holding 99 completed plus one running whose lease had expired ten hours earlier, and all 46 pending jobs outside it. Two ledgers on that machine were stranded at 79 and 41 jobs. Jobs are now selected by eligibility in SQL, so the limit bounds work per pass and never visibility, a node's job is read by key, an expired lease returns to pending, and a failure the lease fence cannot see is recorded. Replaying the same ledger, claimable work goes from 0 to 98. An upgraded binary heals a stranded ledger on its first maintenance pass with no action from you.
- Compacted summaries carry the addresses of what they summarized. Each frontier node now renders its own `lcm.summary:` address and the `lcm.raw:` addresses of its sources, or its children when condensed, written from ledger data after the frontier walk and never read back out of model output. Before this the summary was joined model prose, so nothing in it could be expanded. When the byte bound is reached, whole nodes are withheld and named with their addresses; a node is never cut in half and an address is never half-written.
- `memory.recall` reached the newest history instead of the oldest. It read the first 1,000 rows of an ascending ordering, so on a 23,833-entry session it could see 4% of the history and never the part just compacted.
- `memory.expand` on a summary address returns the messages the summary was built from, each with its own address, and descends one level for a condensed node. It previously returned the summary's own text. A constituent longer than the page budget now resumes at its offset before the page advances, so `memory.walk` completes; on a real ledger 10.4% of entries were over the old bound and 33 of 42 ready nodes carried at least one.
- Summarization converges. It escalates from detail to bullets at half the target to a deterministic excerpt, and a level is accepted only when it shrinks its input in UTF-8 bytes. The write gate enforces the same bound for any caller, and the deterministic level is now smaller than its input for every input, including ones below its old minimum.
- Deleting a project removes its quarantined rows. They previously kept a summary's full text while the delete manifest reported nothing remaining. The manifest now counts every table that can hold project content and reports rows it cannot attribute.
- Overflow from a truncated tool result survives. It went to a temporary directory nothing referenced, and a failed write dropped the pointer in silence, so a truncated result read as complete. Overflow now lands beside the ledger under the Fabric state directory, and a failed write says so in the visible text.

### Added

- A full-text index over the immutable store, so `memory.recall` answers from an index instead of a scan, and `queryMode` literal, phrase and regex are honored on the LCM route. Where the SQLite driver has no fts5 the search degrades to a bounded scan and reports itself incomplete.
- `compaction.softThresholdRatio` (default 0.55) gates maintenance by context occupancy, so a session below it costs no summarization calls. Persistence is never gated: every entry is still logged. `compaction.hardThresholdRatio` (default 0, off) exposes a forced compaction trigger; the host keeps owning that trigger until you set it. Both treat 0 as off.
- `retention.outputArtifactMs` (default 7 days) and `retention.outputArtifactMaxBytes` (default 256 MB) bound the overflow directory. The sweep runs on the first overflow write of a session and at most every five minutes, and it never removes a file a running session still points at.
- The LCM view names what session reconciliation dropped, so entries skipped as oversized are visible instead of being counted as a healthy import.
- Every configuration key is editable from `/fabric settings`. 39 of 165 keys had no working row: some were absent, and one rendered as editable while doing nothing on Enter. Memory, Speculation and Models gained sections, per-tool capture risks are derived from the config so a new default entry appears on its own, and the host call timeout map became a real editor. Four keys stay file-only or aliased by an enumerated decision that carries its reason: `components` and `schema.trustedCommands` hold records a fixed row cannot validate, and the two per-model compaction threshold maps are written through the single threshold row for the active model. A test derives the key set from the config at run time and fails when a new key arrives without a row, proving for each row that it reads and writes that exact path.

### Changed

- The backup manifest is version 2. Its digest covers a table that did not exist before, so a backup taken with an earlier release no longer matches; restoring one is refused by version instead of failing as corruption. Take a fresh backup after upgrading.
- The delete manifest is version 2 and reports per-table counts.
- Foreign keys are enforced on the summary graph. The derived tables are rebuilt once on first open, and rows that cannot satisfy a constraint are recorded rather than dropped.
- The summary expansion page budget is 20,000 characters, matching the raw route. `entryCount` on that route counts the whole descent, and an out-of-range index, range or offset is refused instead of clamped.
- Indexed and degraded search agree. Both tokenize the query the same way, so a substring like `oo` no longer matches `foobar` on one backend and not the other.

## 1.11.0

### Fixed

- The deterministic excerpt no longer starves its own content. Its provenance budget was computed as everything the header did not take, so a node with many sources consumed the whole limit and the excerpt was left with nothing. Measured against a 150-source node: at the 16,384-char default the excerpt carried 0 bytes of content before and 7,760 after; at 4,096 it carried 0 before and 2,417 after. Content now holds a floor of 60% of the budget and takes whatever provenance does not use.
- Provenance truncates at handle boundaries and states what it dropped, as `+137 more`. It previously cut mid-identifier, leaving a trailing fragment that resolved to nothing.
- Deterministic nodes carry the recovery pointer. Model-written summaries already named `memory.recall` and `memory.expand`; the deterministic renderer named nothing, so the excerpt that had lost the most detail was the one that never said how to get it back. At limits too small to hold both, the pointer is dropped before content is.

## 1.10.1

### Fixed

- The Activity and Topology footers now list `3 lcm`. The view shipped in 1.10.0 but only the `?` help screen named its key, so from the two views that can reach it the ledger was invisible. A test fails if either footer stops advertising it.

## 1.10.0

### Added

- The dashboard carries the LCM ledger on key `3`. It shows the coverage band for the active branch, the node graph paged in bounded requests, the text a compaction would assemble right now beside the session payload it draws from, and a node detail that opens the exact stored raw entry behind any source. A node whose excerpt was later replaced by a model summary shows both, so the upgrade can be judged rather than assumed.
- Summary nodes keep their replaced text. `summary_node_revisions` records the prior text and model hash whenever maintenance rewrites a node, which is what makes the excerpt-versus-summary comparison possible.

### Changed

- `/fabric lcm` is gone; the dashboard view replaces it. The single-line summary in `/fabric status` stays.
- The ledger read paths that feed the view are aggregates rather than row walks. Measured on a live 5,392-entry session: the coverage scan reads identity columns in 15.7 ms against 150.7 ms for the previous full-row walk, and session payload size is one aggregate at 35.2 ms against roughly 620 ms for the per-entry loop it replaces. Preview, coverage, and the coverage map now share a single frontier walk, and node listing pages in SQL rather than slicing an oversized read.

## 1.9.1

### Fixed

- Reconciling the session a run is actively writing failed every time, so the live session contributed nothing to the ledger and `/fabric lcm` reported a degraded runtime. The reader compared the file's size and mtime before and after reading and rejected any difference, but session JSONL is append-only and a live session grows during the read: a concurrent writer produced `errors: 1, imported: 0` on five attempts out of five. A longer file is now accepted, and only a shrinking one is refused; the same fixture then imported 4,044 entries and kept up with the writer.
- Tagging a release stopped publishing the GitHub release. The CI rewrite in 1.8.1 dropped that step while removing duplicated verification, so v1.8.1 through v1.9.0 reached npm with no release entry. The step is restored and the missing releases were created.

## 1.9.0

### Added

- `compaction.lcmModelTimeoutSeconds` bounds one summary call and defaults to 120 seconds, raised from a hardcoded 60. A leaf may now carry 200,000 characters of evidence, which a slower provider could not always summarize inside the old minute, and overrunning it writes a deterministic excerpt while the model is healthy.
- Every compaction key is editable in `/fabric settings`. Eleven of them, including the maintenance passes, leaf and prompt bounds, model budgets, and the new timeout, were reachable only by hand-editing `fabric.json`. A test now fails when a compaction key has no panel entry.

## 1.8.3

### Fixed

- The compaction line in `/fabric status` read `6/24 model summaries`, which looks like a quota of 24. It was the share of ready nodes the model wrote, and model calls carry no quota. The line now reads `24 nodes (6 by model, 18 excerpt)`.

## 1.8.2

### Fixed

- Upgrading a deterministic node left the text readers actually see unchanged. Context assembly serves the frontier, and a leaf folded into a condensed parent is no longer on it, so replacing that leaf's excerpt with a model summary improved nothing while spending a model call; the parent kept prose written from the excerpt and, carrying a real model hash, was never reconsidered. An upgrade now reopens the ready ancestors of the node it improved, so the summary that reaches the model is rebuilt from the upgraded child.
- The Test workflow keyed its concurrency group by branch, so a second commit cancelled the run still verifying the first. The release gate reads the run for the tagged commit and would have refused a cancelled one, which this repository's push-then-tag rhythm makes likely. The group is keyed by commit.

## 1.8.1

### Changed

- CI stops repeating work. Release ran the full Windows check and then a second full check through `prepack`, so publishing a tag re-verified a commit main had already verified, seven minutes for zero new information. Release now waits for the Test run of the same commit, builds `dist/`, and publishes without lifecycle scripts. Test splits its suite into two shards per platform and carries typecheck, build, and dead-code lint on one shard rather than both, and every workflow restores the bun install cache, which was the slowest step on Windows at 36 seconds.

## 1.8.0

### Changed

- Model summaries carry no budget by default. `lcmMaxDailyModelCalls`, `lcmMaxSessionModelCalls`, and `lcmMaxDailyModelSeconds` now default to 0, which means no cap, so a deterministic excerpt appears only when the summary model cannot be called. Setting any of them applies that cap, and `compaction.lcmModelSummaries: false` turns model summarization off outright for a session that should never spend on it.

### Added

- Maintenance replaces a deterministic node with a model summary once the model answers again. A node written by the emergency reducer previously owned its source range forever, because leaf selection treats any ready node as covering its sources, so a single provider outage or exhausted budget left that range as an excerpt permanently. `/fabric lcm` reports how many such nodes are queued.

## 1.7.0

### Added

- `/fabric status` reports an LCM line, and `/fabric lcm` reports the detail behind summary quality: frontier coverage for the active branch, model-written against deterministic nodes, pending jobs, today's model spend against its budget, and the effective pass and leaf limits. It names the cause when the frontier is thin, when the remaining daily budget cannot fit another call, or when no summary model is set, which previously took a hand-written SQLite query to discover.

## 1.6.0

### Fixed

- LCM compaction fell back to deterministic excerpts after about four model summaries per day. The maintenance budget spent a 60-second wall-time quota that is accounted per project per day, and each summary of a real session took roughly fourteen seconds, so the fifth call was refused and every later node was written by the emergency reducer. Observed on a live 2,368-entry session: four model-written leaves covering 32 sources, twelve deterministic nodes, and 55,110 ms of 60,000 ms spent. The daily quota is now 7,200 seconds, a separate 60-second guard bounds a single maintenance run so turns stay responsive, and the compaction that fires reads model summaries.
- Leaf selection clipped evidence. A leaf took a fixed count of entries with no regard for their size, and on the measured session the ninetieth-percentile leaf reached 62,040 characters against a 48,000-character prompt bound, so the tail was cut before the model saw it. Leaves are now packed up to the input budget and always carry at least one entry.

### Changed

- Compaction defaults target model summaries rather than fallbacks: leaves hold up to 32 entries (was 8) inside a 200,000-character prompt budget (was 48,000), a maintenance run makes up to 8 passes (was 4), and the model budget allows 512 daily and 256 per-session calls (was 32 and 16). On the measured session this covers the same 2,368 entries in roughly 43 calls rather than 296.

### Added

- `compaction.lcmMaxDailyModelCalls`, `compaction.lcmMaxSessionModelCalls`, and `compaction.lcmMaxDailyModelSeconds` expose the model budget that was previously a fixed constant.

## 1.5.0

### Added

- LCM runs on Bun's own SQLite. `src/storage/sqlite.ts` resolves `node:sqlite` first and falls back to `bun:sqlite`, so a runtime that ships only Bun's driver keeps durable ledger compaction rather than losing it. The ledger, maintenance, backup, checkpoint, rollback, and restart paths are covered against the Bun driver directly.

### Fixed

- Installing or loading the extension failed outright on runtimes without `node:sqlite` (`Failed to load extension: Could not resolve: "node:sqlite"`), which took down every Fabric feature rather than only LCM. The entry bundle pulled the ledger in statically through `src/index.ts`, `src/agents/handoff.ts`, and the memory provider. The sqlite-free identity and payload helpers now live in `src/storage/lcm-identity.ts`, the LCM runtime loads from the stable lazy entry `dist/compaction/lcm-runtime.js` only when compaction needs it, and a runtime that cannot resolve `node:sqlite` keeps the extension running with compaction delegated to OMP core plus one warning. `bun run build` now fails when anything in the startup static graph imports `node:sqlite`.
- Windows CI failed on unrelated files with 5 s test timeouts that passed on rerun, and the v1.4.6 release was correctly withheld by the new Windows gate because of it. The suite now scales its test and hook deadlines on Windows runners, where it executes roughly three times slower, and keeps the tight defaults elsewhere.

## 1.4.5

### Added

- `compaction.lcmMaintenancePasses` (1-64, default 4) bounds how many leaf/condense passes one maintenance run makes. A run summarizes at most `lcmMaintenancePasses x lcmMaxLeafEntries` raw entries, so the knob trades model spend for frontier coverage on sessions that ingest faster than maintenance keeps up.

### Fixed

- Maintenance used `lcmMaxCondenseChildren` as its work budget, so the condensation fan-in silently decided how much summarization ran per turn. The two are now separate: fan-in shapes the DAG, passes bound the work.
- Process-spawn tests in the actor and agent managers ran under the 5 s default timeout and timed out on Windows runners while passing on rerun. The six spawn-bound tests now carry the 30 s timeout their siblings already used; no assertion changed.

### Changed

- Releases wait for a `windows-latest` check job before publishing. `prepack` already ran the full gate on Linux, but a tag could publish while the Windows matrix leg was red.

## 1.4.4

### Fixed

- Changing Compaction > Summary model (or any LCM bound) took effect only in the next session. The runtime captured its options once at construction and is rebuilt only when the project, cwd, or engine changes, so a model picked mid-session kept summarizing with the previous one. `LcmRuntime` now resolves its options at use time and the extension supplies them from live config, so the next maintenance pass and the next compaction read the current setting.

## 1.4.3

### Added

- `/fabric settings` exposes Compaction > Summary model. The entry opens the OMP model picker, so the LCM summary model is chosen from the models OMP actually has rather than typed by hand, and Inherit clears the override back to the active session model. The setting was previously reachable only by hand-editing `compaction.summaryModel` in `fabric.json`, which left reasoning models summarizing transcripts at their own price.

## 1.4.2

### Fixed

- Resuming a session failed with "LCM session reconciliation failed with exit code 1" and imported nothing. Real OMP session files start with a `type: "title"` preamble record and declare the `type: "session"` header on the next line, but the reconciler required that header on line 1 and rejected the file. It now accepts the header after preamble records and reports a source that never declares one. Measured against real session files: 4,375 / 3,928 / 9 entries imported with zero malformed rows, where every one previously imported zero.
- Reconciliation no longer aborts a resume over per-row diagnostics. Malformed or oversized rows stay reported in the result counts, and only a genuine ledger or I/O error marks the runtime degraded.

## 1.4.1

### Fixed

- LCM suites left SQLite handles open on windows-latest: Bun's `node:sqlite` keeps the database, WAL and shared-memory descriptors open after `close()` reports the handle closed, releasing them only at collection, so `afterEach` removal failed with `EBUSY`. Tests now hand every ledger and runtime to a shared fixture that closes tracked handles, drops their references, forces collection, and retries removal, tolerating only lock codes on Windows. `LcmLedger.close()` is idempotent and marks itself closed only after the underlying close succeeds.
- The ledger backup test asserted POSIX permission bits on Windows, where `chmod` honours only the read-only flag; that assertion now runs where it has meaning.

## 1.4.0

### Added

- Replaced active Fabric compaction with durable LCM context management using a SQLite raw ledger, hierarchical leaf and condensed summaries, source lineage, bounded emergency reduction, and exact memory recovery.
- Added on-demand reconciliation for the selected resumed OMP session; unrelated sessions are not imported during startup.
- Added bounded summary-model maintenance with public OMP model resolution, lease fencing, retry limits, daily usage budgets, branch isolation, and operational backup/deletion safeguards.

### Changed

- `compaction.engine` now accepts `lcm` or explicit `omp`; persisted `fabric` values migrate to `lcm`.
- `memory.recall` and `memory.expand` can use the lifecycle-owned LCM ledger while preserving bounded active-branch recovery.

## 1.3.4

### Fixed

- The 1.3.3 regression test compared a Windows path against a JSON-escaped message string, so windows-latest failed on backslash doubling and the `RUNNER~1` short path while the behaviour under test was correct. It now asserts on the filesystem: the file exists under the artifacts root and does not exist under the fallback root. 1.3.3 was tagged before that job reported, which is why a release carries a red Windows check.

## 1.3.3

### Fixed

- **A `local://` write and a `local://` read still disagreed after 1.3.2.** Delegating to the host write tool stopped the literal `local:` directory, but the two sides derived different roots. `resolveLocalRoot` prefers `getArtifactsDir()` and falls back to `<tmp>/omp-local/<sessionId>`; the read path takes its options from the main session in the global agent registry, so it always used the real artifacts directory, while Fabric's core tools ran on a synthetic session that supplied neither accessor and landed in the fallback. Measured: the write reported success at `/tmp/omp-local/session/rt.md`, the file existed there, and reading the same URL raised `Local file not found`.

  Fabric's synthetic session now carries the host session's identity, so `omp.read` and `omp.write` resolve one `local://` URL to one path. Verified live: the write lands in the session artifacts directory and the read returns the bytes.

### Notes

- 1.3.2 was released as verified on a smoke test whose read-back had been dropped from the probe, so only half the round-trip was exercised. The first attempt at that smoke did surface the mismatch and filed it, and the report was not read before shipping.

## 1.3.2

### Fixed

- **`omp.write` never resolved an internal URL, so `local://` writes landed in a literal `local:` directory.** Fabric replaces the host's write tool with its own implementation to attach diff previews, and that replacement carried no internal-URL handling: `resolve(cwd, "local://notes.md")` collapses the scheme into a path segment and produced `<cwd>/local:/notes.md`. Subagents are instructed to exchange findings through `local://` files, so a real project accumulated one of these directories with five files in it. Meanwhile `omp.read` resolves `local://` correctly, because Fabric binds the host's read tool unchanged, so a write and a read of the same URL disagreed about where the file was.

  URI-like write targets are now delegated to the host's write tool, which resolves them: `local://round-trip.md` writes to the session's local root under `omp-local`, `xd://` reports that no device is mounted, `artifact://` reports that it is read-only for writes, and an unknown scheme keeps the host's own guidance. Ordinary filesystem writes keep the diff preview.

  1.3.0 turned the silent mis-write into a refusal, which stopped the stray directories but left agents unable to write `local://` at all under full code mode, since the top-level write tool only accepts `local://` during plan mode. This completes that fix.

### Notes

- A directory literally named `local:` inside a project is the signature of this defect from any Fabric before 1.3.0. Its contents are real files and can be moved or deleted; nothing reads them at that path.

## 1.3.1

### Fixed

- **A code map built outside a project could crawl for minutes.** `codemap.cascade` degrades when the workspace is not a git repository; the symbol index had no equivalent bound and was limited only by `maxFiles`. Indexing `/tmp` took 94.4 seconds. A wall-clock ceiling, `codemap.maxMs`, now bounds the filesystem walk, each native pattern pass and the fallback pass: measured at 30.1, 10.0, 5.1 and 2.0 seconds against ceilings of 30s, 10s, 5s and 2s, an overshoot of 0 to 2 percent. A pass cut short yields a partial map with `truncated` set; it does not raise. The 30-second default never bites on a real project, which indexes in 3.8 seconds here.

  Bounding the passes between calls was not enough on its own: a single native pass over 4,000 files outran the whole budget, so the remaining budget is now passed to the native call as its own timeout, and enumeration is bounded too. Without both, a 5-second ceiling still took 8.8 seconds.

  Only a genuine timeout counts as truncation. The first cut caught every error from the pattern pass and reported a partial map whenever a budget was set, which would have hidden a real fault behind a plausible-looking result; anything that is not a timeout now propagates.

### Notes

- The global actor `cwd` threading shipped in 1.3.0 without a negative control. It has one now: removing the `toRequest` spread turns `tests/global-actor-cwd.test.ts` red, so the round-trip test defends the fix and does not pass incidentally.
- A windows-latest failure in the budget tests was fixed by two changes in one commit, the narrowed catch and smaller fixtures, so which one cured it is not established. The narrowed catch is correct on its own terms: masking an arbitrary failure as a partial result is wrong whether or not it was the cause here.

## 1.3.0

Three read-only audits went looking for places where an agent is blocked by a parameter the underlying tool already supports. Every change below is additive: each new parameter is optional and omitting it reproduces 1.2.0 behaviour.

### Fixed

- **`omp.write` reported success for a device it never called.** `omp.write({ path: "xd://recall", text: "..." })` answered `Successfully wrote 2 bytes to xd://recall` while actually creating a literal `xd:` directory under the session cwd, because `resolve(cwd, "xd://x")` collapses the scheme into a path segment. An unknown device name reported success too. URI-like targets are now rejected with a named error pointing at the top-level `write` tool, which carries the `xd://` transport even under full code mode. Device dispatch itself is not reachable from an extension: it needs the host `ToolSession.xdev` map, and Fabric's synthetic session has none.
- **`omp.grep` dropped `gitignore` and `omp.find` dropped `gitignore` and `hidden`.** Both were discarded while rebuilding arguments, so searching build output or a vendored tree from a repository root returned nothing and reported no matches. `grep` now forwards the flag, and `find` routes through the host `GlobTool` when either filter is present.
- **`omp.bash` accepted `env` at runtime but the guest declaration rejected it.** The type checker does not suppress TS2353, so a supported parameter failed before execution with `'env' does not exist in type`. `env` and `pty` are now declared.
- **A per-call agent `timeoutMs` below the configured default was discarded.** Fanning out cheap probes with a short deadline was impossible: a hung child held the parent and a concurrency slot for the full configured timeout. The value is now clamped into the supported range in both directions.

### Added

- **`codemap.map` and `codemap.cascade` take a `path`.** They previously indexed the session directory and nothing else; running from a scratch directory indexed 4,000 unrelated files in 93 seconds. Relative values resolve against the session directory, absolute values are taken as given, and a missing path or a file is rejected by name. `map` reports the `root` it used.
- **`memory` gained a `project:<path>` scope.** `recall` and `sessions` could only reach the project the session runs in. The new form is parallel to the existing `session:<id-or-path>`, and a bad path raises `InvalidProjectScopeError` rather than returning an empty result that reads like an answer.
- **`agents.create` accepts `cwd`.** One-shot agents already did; a persistent actor could never be pinned to another checkout.
- **`agents.run` and `agents.spawn` accept `images` and `addTools`.** The image pipeline existed end to end and only the provider translation dropped it. `addTools` merges onto the resolved tool list, so asking for the defaults plus one more no longer means restating every default.
- **`mcp.$call` accepts `timeoutMs`**, clamped to a 15-minute ceiling and defaulting to the configured call timeout.
- **`mesh.list` and `mesh.members` accept `withTotal`.** Both truncated silently with no way to tell a complete answer from a clipped one. With the flag they return the page plus `total` and `truncated`; without it the return shape is unchanged.
- **`memory.sessions` accepts `offset`** and reports `total` and `truncated`, so a caller can page past the 500-session cap.

- **`memory.sessions` reported a capped count as the total.** The browse was bounded by `memory.maxSessions` (500), so a project with more sessions read `total: 500` with `truncated: false` and looked complete. The count is now unbounded, which is also what makes `offset` able to page.
- **The new `gitignore` and `hidden` filters were absent from the published descriptors.** The schema augmentation ran against a callable omptype schema instead of a JSON document and silently returned it unchanged, so `tools.describe`, `tools.list` and the action catalog never saw them. The pre-existing `skip` parameter had been invisible the same way.
- **A global actor template dropped `cwd`.** `agents.create` validated and accepted it for every scope, but `GlobalActorRegistry` carried no such field, so a global template silently lost the directory and still reported success. It now round-trips through save, load and `toRequest`.

### Notes

- Two audit findings were rejected after probing rather than shipped: `omp.read` does honour `offset`/`limit`, and `omp.grep` does search a gitignored tree when the path points directly at it. The grep defect is real only from a parent directory, which is how the flag reaches the host at all.
- A review finding was rejected with evidence: the `omp.write` rejection message points at the top-level `write` tool, which stays reachable under full code mode because the host keeps it as an `xd://` transport tool rather than an ordinary core tool.

## 1.2.0

### Added

- **Code map (`codemap.map`).** A repo-wide symbol index disclosed under an explicit token budget. It is built from the host's native ast-grep binding with `$NAME` metavariable capture, so it needs no extra dependency, and it emits `<line> <letter> <name>` under a bare file header with a one-line legend. Measured on this repository at the tag, 293 TypeScript files and 3,412,131 raw bytes: the map is 210,675 bytes, a 16.20x compression, against 313,626 bytes and 10.88x for the `ast-grep outline` CLI. Languages with no pattern entry fall back to filtered `summarizeCode`, so coverage extends past the pattern table. Reproduce with `bun run benchmark:codemap`, which fails below a 15x floor.
- **Co-change ranking (`codemap.cascade`).** Ranks files by how often they changed in the same commits as a seed, scored as `shared / sqrt(seedCommits * candidateCommits)`. Raw counting would put lockfiles and changelogs first; the normalisation removes that bias. Merge commits and commits touching more than 100 files are excluded so vendored sweeps and formatter runs invent no affinity. A non-git workspace returns an empty graph with `unavailable` set and never throws. This answers which files a change drags along, which `grep`, `ast_grep`, and `lsp` cannot.
- **Budget spending that ranks before it spends.** `focus` scores files by query relevance, `seeds` folds in co-change affinity so a historically related file surfaces even when its name shares nothing with the query, and with neither the order is deterministic. Exported symbols win the last slots inside a file that does not fit whole. `omittedFiles` and `omittedSymbols` report exactly what was left out.
- **`prewalk.handoffRetirement`.** When an executor handoff goes live, the planner's stale successful `read`, `grep`, `find`, and `ls` results are replaced with a compact marker naming the tool, the target, and the original size, so the executor does not re-ingest exploration it will not use. Failed results, mutating tools, user messages, results carrying images, and the most recent `prewalk.handoffRetirementKeep` reads are never touched. The marker stamps OMP's existing `prunedAt` field, which makes retirement idempotent.

### Fixed

- The symbol index enumerated gitignored files. Indexing this repository at its root found 3,425 files, most of them gitignored benchmark checkouts; it now uses `git ls-files --cached --others --exclude-standard` and finds 542, falling back to a filesystem walk outside a git repository.
- A scoped `codemap.map` scanned the whole workspace anyway. The caller's glob filtered results after the native pass, so it narrowed nothing; the scan is now rooted at the common directory of the selected files. Indexing `src/codemap/**/*.ts` on this repository went from 3,553 ms to 54 ms.
- The six new numeric settings rows carried no editor, so they rendered as editable and did nothing on Enter. Each now opens an integer editor bounded to the range `normalizeFabricConfig` enforces.

### Notes

- `handoffRetirement` applies to the trajectory handoff, where Fabric materializes the executor's session. The in-place path leaves OMP's own append-only log as ground truth, which an extension cannot rewrite; `prewalk.compactOnReturn` remains the mechanism there.
- Retirement reaches file-backed sessions on every thinking-transfer policy. A first cut honoured the pruned branch only when planner and executor shared a provider; every cross-provider handoff, which is the ordinary case, re-read the unpruned branch from disk and discarded the pruning while still reporting the bytes it claimed to save. `tests/prewalk-handoff-seam.test.ts` drives the real `writeHandoffSession` across all three policies, and the two cross-provider cases fail without the fix.

## 1.1.0

### Added

- **Update notice in the TUI.** Fabric now tells you when a newer release is published, as a quiet status line naming both versions and the command that works: `omp plugin install omp-fabric`. The host's own auto-update covers marketplace plugins only, and `omp plugin upgrade` rejects npm plugins, so an npm install had no notification path at all.
- The check reaches the network at most once every 24 hours, caches to `<agent dir>/fabric/update-check.json`, announces a version once and then stays quiet, and is silent on every failure: offline, non-200, malformed payload, or an unwritable cache. It is skipped entirely when the session has no UI and inside spawned child agents, so headless runs and subagents cost nothing. Turn it off with `update.check: false`.
- This is the extension's first outbound network call. Before it, `src/` contained none.

## 1.0.5

### Fixed

- **Full code mode hid every skill from the model.** The host renders its `<skills>` listing only when the native `read` tool is active (`system-prompt.ts`), and full code mode removes `read`, so the whole block was dropped. Fabric's compensation read the skill list from `event.systemPromptOptions.skills`, a field the host does not have, so it always rebuilt from an empty array. Measured on a machine with 562 skills on disk: the model saw 0 with Fabric loaded and 394 without it. Agents therefore fell back to globbing the filesystem for `SKILL.md` files instead of loading `skill://<name>`. The listing is now rebuilt from the host's own `getActiveSkills()` registry, honours the `skillful` setting and the host's `hide` filter, and carries a load instruction naming the mechanism that works under full code mode.

## 1.0.4

### Fixed

- `omp.ls` was the one core tool that never emitted the partial-result marker, so a listing the host clamped at its entry cap looked complete to any program following the documented contract. It now carries the same marker, and its continuation is real: the host does not clamp a larger `ls` limit, so the marker offers one that returns the rest.

## 1.0.3

### Fixed

- **Reads never paged on Windows.** The guard that decides whether a path is pageable scanned for the last colon in the whole path string, and a Windows drive designator is a colon, so `omp.read` stopped at the host's per-call line cap and reported the wrong reason for stopping. The drive root is now excluded from that scan on every platform. Windows users were getting the truncated reads that 1.0.0 set out to fix.
- Three test files assumed a POSIX environment: a drive-letter path encoding, two bash fixtures that read `/dev/zero`, and PATH fixtures that Windows could not resolve. All three now run on both platforms with no skips.

## 1.0.2

### Fixed

- The durable residency end-to-end suite treated the presence of an `agent.db` file as proof that a model was configured. The suite creates that file itself, so a credential-free runner booted a real OMP host and reported eight failures for a missing model. The gate now reads only an API key environment variable, a `models.yml`, or an explicit `FABRIC_RESIDENCY_E2E` opt-in.

## 1.0.1

### Fixed

- The test suite ran against the developer's real OMP agent directory, so it could write into `~/.omp/agent` and its result depended on what was already there. Every run now gets a scratch agent directory unless `PI_CODING_AGENT_DIR` is already set, which also stops the durable residency end-to-end suite from booting a host on a machine with no credentials.

## 1.0.0

First stable release. Every feature in this release was verified by running it against a real OMP session, not by reading the code.

### Fixed

- **Guest tool results were model-facing renderings, not data.** `omp.read` stopped at 300 lines and cut any line past 768 bytes with an ellipsis, `omp.grep` and `omp.find` capped silently, `offset`/`limit` were dropped before reaching the host, and an unreadable binary arrived as prose on the success path. Results are now faithful, or they carry exactly one machine-parseable `[[omp-fabric:truncated]]` marker on a final line. A complete result stays byte-identical. Measured: a 5000-line file returned 3000 lines before and returns all 5000 now, in one call instead of two.
- **`omp.bash` truncated every output line at 768 bytes.** The host executor reads global settings and ignores the caller's session, so the bytes could not be kept that way. They are recovered from the artifact Fabric itself allocates, with a prefix-consistency check. Measured: a 200 KB single line returned 767 characters before and returns all 200004 now.
- **Repeat reads were not idempotent.** The third identical read of a path had ~180 characters of host guidance glued onto it.
- **A vanished artifact directory killed `omp.bash` permanently** for the rest of the session. Allocation is now ensured per call and never fatal.
- **Every child agent failed on a stock box.** Worker runtime selection preferred Node, which cannot load the worker bundle, and the launch discarded stderr, so the only symptom was a transport message with no cause in it. Selection now prefers Bun, and a startup failure names the runtime and quotes the real error.
- **`agents.defaultTools` shipped a tool name the child CLI rejects**, so even a booting child exited 1.
- **Project-scoped memory could never match.** The extension re-derived OMP's session directory name with its own encoding; none of the real directories matched, and it reported a broken scope as an honest empty corpus. It now re-spells the host algorithm, accepts superseded names, and reaches a `--session-dir` store. No reindex.
- **Speculation never ran.** Stream events were dropped while the runtime was still cold, and the scanner rejected the positional call shape models actually write. It now serves hits, and `speculated` survives into the session record.
- **MCP tools were undiscoverable on a first run in a new project**, while being callable if the name was already known. A cold catalogue reported itself complete. First enumeration now lands in the catalogue, later projects seed from a global descriptor cache, and an incomplete catalogue says so.
- **Settings saved from a trusted project** went to `<project>/.omp/fabric.json`, so preferences did not follow the user between repos.

### Added

- `compact.status` reports context occupancy, window, engine and target ratio, and the settled outcome of a requested compaction is readable afterwards. It previously returned an empty object.
- The `extensions` and `mcp` guest proxies enumerate, so `Object.keys` matches what `tools.list` reports, with no host call.
- Each `fabric_exec` run records `speculation: {launched, hit, missed, discarded}`.

### Changed

- Defaults now favour capability: full code mode on, 8 concurrent children, agent depth 3, 10 concurrent speculations, 256 MiB executor heap ceiling, 100 hot memory sessions, thinking indexed for recall, and an MCP call timeout below the executor deadline so a slow server fails one call instead of the whole program.
- Settings save globally by default; project overrides remain an explicit opt-in.
- Reading a file the host cannot decode now throws with a branchable prefix instead of returning the notice as content.
- The build type-checks before deleting `dist`, so a failed build no longer leaves the tree without one.

### Benchmark

Paired run on the DeepSWE-style `scc-bounded-memory-spilling` task, same model and thinking level, both arms solving the task with all eight verifier checks green:

| | baseline | fabric |
|---|---|---|
| tokens | 15,801,323 | 3,505,921 |
| cost | $15.99 | $4.53 |
| wall | 1381 s | 491 s |
| turns | 114 | 47 |
| tool calls | 123 | 45 |

Single task, single repetition. The same paired task measured 6,553,256 tokens and $8.21 for the fabric arm before the fixes in this release, so roughly half of the remaining gap came from the truncation and speculation defects above.
