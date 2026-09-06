# Context and memory certification

The repository provides three evaluation commands:

- `bun certify:context` is deterministic, runs offline, and costs nothing.
- `bun run certify:entropy` is deterministic and offline: fixed corpora through the versioned [tool-entropy meter](entropy.md), with a ratchet proof, the compile loop (applied, gate-rejected, and converged rounds), ingestion checks, and, against a real corpus with `--trial`, the held-out divergence trial that fails if the compiled artifact would reject any recorded successful call. With `--trial` and no `--artifact`, the compiled artifact is read from `<agent dir>/fabric/entropy/compiled.json`, where the agent dir is `OMP_FABRIC_AGENT_DIR` (expanding `~` and `file://`) and otherwise the host's `getAgentDir()` default of `~/.omp/agent`; a missing artifact fails `trial-mode` and names the directory it searched.
- `bun benchmark:real-resume` is an opt-in, billable OMP RPC benchmark with a safe skip as its default behavior.

`bun test` excludes these commands, which keeps the normal test suite offline and fast.

## Deterministic certification

Both certification commands run under Bun. They import the installed host package, whose `exports` map points `import` at TypeScript sources, and Node refuses to strip types for files under `node_modules`:

```sh
bun certify:context
bun certify:context -- --json /tmp/omp-fabric-certification.json
```

The package command builds `dist/` first, then runs `scripts/certify-context.mjs`. It prints a human summary followed by the complete JSON report. When any threshold fails, the command exits nonzero.

### Compaction endurance

The harness builds a persisted session through OMP's `SessionManager`. Messages and compactions go in through its public methods. The active parent-linked branch comes back through `getBranch()`. Under deterministic settings (`contextWindow=64`, `reserveTokens=63`, `keepRecentTokens=1`), the harness performs exactly 100 Fabric compactions. Before every hook event it sums the host's `estimateTokens` over `SessionManager.buildSessionContext().messages`, applies `shouldCompact`, and requires `prepareCompaction` to return a preparation. It then invokes the callback registered by `registerCompactionHook` with OMP's `SessionBeforeCompactEvent` shape: `type`, `preparation`, `branchEntries`, an optional `customInstructions`, and `signal`. That event carries neither a compaction reason nor a retry flag, so certification asserts nothing about either.

The host package is `@oh-my-pi/pi-coding-agent`. Certification reads the installed version from its own `package.json` and checks it against the range `omp-fabric` declares in `peerDependencies`, so no certified version is hard-coded; a host outside the declared range aborts the run and reports both the range and the resolved version and path. Each function is then resolved from a supported entry point, and a missing one aborts the run naming the entry point: `SessionManager` and `buildSessionContext` from the package root, `estimateTokens` from `@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim`, and `prepareCompaction` plus `shouldCompact` from `@oh-my-pi/pi-agent-core/compaction`. At the pinned 18.1.10 host the package root exports `SessionManager` and `buildSessionContext`, does not export `prepareCompaction` or `shouldCompact`, and has no `buildContextEntries` export at all; the report records each of those observations under `hostApi.rootExports`. No public API supplies a preparation unless an `AgentSession` runs with a model, so certification makes no claim past that.

Every persisted summary carries a cycle-unique `PRIOR_SUMMARY_POISON_991_…` suffix inside the actual `CompactionEntry`. On the next cycle, OMP's preparation has to expose that exact stored previous summary. A proxy around the event preparation records whether the registered Fabric callback reads `previousSummary`. The result derives from those accesses. Fabric must leave the value unread and keep its poison out of anything it emits. No step converts a summary into a user message by hand.

Every cycle also checks:

- the original goal, constraint, and pinned Unicode rare fact
- the cumulative source, file, and unresolved-error addresses
- tool-call/result closure at the kept boundary
- the presence of every nonempty `firstKeptEntryId` on the active branch
- exact round trips of persisted summaries and details
- agreement between `SessionManager.buildSessionContext()` and the public `buildSessionContext(entries, leafId)`
- a resolved context that, after the compaction and after each subsequent append, is identical to the context the host resolves from the retained entries alone: those from `firstKeptEntryId` onward, the `compaction` entry, and everything appended after it
- a valid UTF-8 summary size of at most 32 KiB.

The last 20 summary sizes must span a range of at most 512 bytes. Their absolute least-squares slope must stay at or under 16 bytes per cycle. These bounds catch late unbounded growth while letting cycle sizes differ.

Six explicit eligible closure fixtures must each run at least once: normal, compact-all, OMP split-turn preparation, parallel/delayed results, reverse-order call/result, and malformed prior boundary. The harness checks every resulting Fabric cut for call/result closure.

A separate maximal source of about 330 KiB mixes multibyte goals, instructions, paths, errors, turns, and typed Fabric activity. Its summary must reach at least 24 KiB, stay within 32 KiB, and survive a round trip through a fatal UTF-8 decoder. This fixture pushes the bound close to its reachable projection saturation. The endurance fixture alone plateaus naturally at roughly 5.8 KiB.

The certificate covers deterministic cumulative projection, OMP eligibility and context behavior, closure handling for the named fixtures, and byte-safe saturation for generated typed event streams. Arbitrary human conversations and general model behavior require separate evaluation.

### Cross-layer memory

The same run creates 1,000 additional persisted OMP sessions. One unique rare-fact session receives an old source mtime. It must classify as cold. Only eight sessions may stay hot. Certification calls `MemoryProvider` directly. No shell output gets parsed.

The pass conditions are:

- at least 1,000 eligible sessions with complete indexing coverage
- exact lexical recall of the cold rare fact
- exact structural selection of a cold `omp.grep` operation by persisted ref/outcome, followed by source- and lineage-bound hydration
- a nonexistent-ref structural negative control that returns zero results
- a session header whose recorded id matches `SessionManager.getSessionId()`, so a session that cannot be identified from its own JSONL cannot pass
- exact source expansion by its stable entry ID
- exact expansion of every distinct entry ID emitted by the 100 compaction summaries or their structured details
- 100% address expansion agreement with a fresh normalization of the source JSONL
- V6 `sourceHash` integrity checks on both cold hydration and context address expansion.

`memory.expand` caps exact selectors and returned entries per call, so the harness requests the emitted addresses in batches of at most 100 selectors and follows each response's `next` cursor until the selection is exhausted, concatenating the text chunks per entry. Every page has to report the same `sourceHash`; a change mid-expansion fails the run. The JSON report includes the eligible, indexed, and stale counts. It also lists the emitted and expanded address counts plus the cache and source byte sizes.

This proves lexical addressability and exact capability-head addressability through the current cache, digest, search, and source-expansion layers. Fuzzy semantic retrieval, ranking under unrelated corpora, cache performance on all filesystems, and recovery after source deletion stay outside that proof.

### Continuation QA

Continuation QA creates two small temporary repositories. Each holds exact expected final files, an executable Node oracle, and files that must stay byte-identical. A no-model handoff simulator receives only:

1. the compacted summary and the structured compaction details
2. constrained current-session pointer and expansion APIs backed by `MemoryProvider`.

The source phase persists a handoff envelope that holds the compacted context and the current OMP session ID. Task operations and captured session paths never enter that envelope. In the resume phase, the simulator reads that output, builds a fresh `MemoryProvider`, and asks it for a V6 integrity-bound current-session pointer. It then derives the cumulative source entry ID from the compaction details and expands that address with `expectedSourceHash`. The `addressResolved` score comes from the returned entry. The harness never substitutes a constant. No callback closes over `manager.getSessionFile()`.

The simulator decodes `CERT_TASK_V1` and applies its operations only after the source expansion succeeds. When an exact operation or file payload is unavailable, it throws and fails the run. It never fabricates a success. The external oracle then scores exact filesystem state, forbidden-file integrity, and process exit status. The oracle never supplies `task.operations` to the simulator.

This proves that the emitted address, the current persisted session identity, and the allowed memory operations can carry these mechanically executable tasks across a fresh handoff. OMP's compaction result itself exposes no session ID and no source hash. Those two values come from persisted current-session context and from `MemoryProvider`, in that order. Whether arbitrary prose can turn into operations, whether a model will choose to recall, and whether the two fixtures represent all software work stay unresolved here.

## Real OMP RPC benchmark

The benchmark compares two arms in deterministic randomized paired order:

- `baseline`: resumes the full, uncompacted context
- `fabric`: compacts with Fabric, terminates that process, then resumes in a fresh process.

The resumed process receives exactly:

```text
Resume and complete the task.
```

A filesystem and test oracle outside the model scores the result. Reports capture pass/fail diff reasons, tokens, USD cost, tool calls, recall calls, wall time, summary bytes, Wilson 95% pass-rate intervals, and paired win/tie rates. A report names the credential variable and never shows its value. Session and repository data live in a temporary directory. The run removes that directory afterward.

The RPC reader implements strict LF JSONL framing. It splits only on `\n`, strips an optional trailing `\r`, and preserves U+2028/U+2029 inside JSON strings. Node's `readline` plays no part in the reader.

### Safety gate

Without configuration, this command exits zero and reports `SKIP`:

```sh
bun benchmark:real-resume
```

A billable run requires all of these gates:

```sh
OMP_FABRIC_REAL_RESUME=1 \
OMP_FABRIC_BENCH_PROVIDER=anthropic \
OMP_FABRIC_BENCH_MODEL=claude-sonnet-4-5 \
OMP_FABRIC_BENCH_KEY_ENV=ANTHROPIC_API_KEY \
OMP_FABRIC_BENCH_REPEATS=3 \
OMP_FABRIC_BENCH_MAX_USD=5 \
bun benchmark:real-resume
```

`OMP_FABRIC_BENCH_KEY_ENV` names an already-set credential environment variable. The benchmark checks the observed session cost before each next arm starts. It stops once the run reaches the configured budget. A single in-flight request can still exceed the remaining budget. Treat the maximum as a stop boundary. Hard spending caps live on the provider side.

The benchmark proves end-to-end behavior for the selected model, provider, fixture, extension versions, and repeats only. Small samples carry wide confidence intervals. General superiority and full isolation of provider variance stay outside that proof.

The benchmark compares only the explicitly selected baseline and Fabric arms. Its oracle and paired report remain bounded evidence for the configured model, provider, fixture, extension version, and repeats; they do not claim general provider superiority.

## Test coverage

The suite in `tests/certification/` covers:

- strict LF JSONL parsing, including split UTF-8 and Unicode line separators
- the default skip gate and the complete opt-in gate
- deterministic paired order and benchmark confidence/paired reporting
- executable continuation oracle passes and forbidden-change failures
- certification rejection under sabotage of eligibility, poison exclusion, address resolution, or the external oracle
- certification report threshold failures.
