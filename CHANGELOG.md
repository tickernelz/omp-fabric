# Changelog

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
