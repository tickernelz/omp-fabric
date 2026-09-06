# Changelog

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
