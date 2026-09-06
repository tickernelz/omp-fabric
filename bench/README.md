# bench — DeepSWE-style verification loop

Local, paired before/after benchmark for measuring Fabric's token-efficiency
regressions against plain OMP, built to mirror the methodology and metrics of
github.com/Whamp/pi-fabric-deepswe-trajectories (issue: "DeepSWE Performance
Trajectories with GPT-5.6-sol:low").

## What it measures

Per (task, config, rep) cell:

- `reward_binary`, `reward_partial` — from the task's `verify.sh`, whose
  checks are derived mechanically from the task's stated acceptance criteria
- `combined_total_tokens`, input/cached/output breakdown, `combined_cost_usd`
  (GPT-5.6 Sol rates: $5/M fresh input, $0.50/M cached input, $30/M output)
- `agent_wall_s`, `turns`, `tool_calls`, `patch_bytes`
- Read-pathology statistics: total reads, whole-file (unbounded) read share,
  tool results over 50 KB. Fabric cells parse `details.trace.operations`, the
  same extraction that reproduces the trajectories repo's published numbers
  (1505 reads / 78.5% whole-file / 79 results over 50 KB).

## Layout

    tasks/<slug>/task.json   repo URL, base ref (extracted from archived sessions), timeouts
    tasks/<slug>/prompt.txt  verbatim DeepSWE user prompt from the archived cell
    tasks/<slug>/verify.sh   acceptance probes -> reward_binary/reward_partial
    run-cell.sh              one cell: checkout at base ref -> agent -> verifier
    run-matrix.sh            isolated agent dir, vendoring, task x config x rep loop, analysis
    analyze.py               paired summary (solves, McNemar, token deltas, read pathology)

Configs:

- `baseline` — stock OMP with no extension
- `fabric-local` — this repo (`-e <repo root>`), what ships right now
- `fabric-<version>` — vendored published package (e.g. `omp-fabric@0.25.6`,
  the version benchmarked in the trajectories repo)

Every arm shares `--no-rules --no-skills --no-extensions`, so neither arm can
pick up the caller's rules, skills, or globally installed extensions; the fabric
arms load their extension through an explicit `-e` path, which those switches
do not block. OMP exposes no switch for project context files (`AGENTS.md` and
friends), so a task repo's context files reach baseline and fabric arms alike;
the paired comparison stays valid but the arms are not context-free.

Model selection is inherited from OMP rather than pinned in the harness:

    BENCH_OMP_CONFIG   extra config.yml overlay passed to --config
    BENCH_MODEL        explicit model id; empty means whatever OMP resolves
    BENCH_THINKING     thinking level, default low
    BENCH_AGENT_DIR    opt-in isolated PI_CODING_AGENT_DIR; needs its own credentials
    BENCH_RATE_INPUT / BENCH_RATE_CACHED / BENCH_RATE_OUTPUT
                       per-million USD rates, used only when the session records
                       carry no provider-reported cost

## Run

    ./run-matrix.sh --tasks scc-bounded-memory-spilling \
      --configs baseline,fabric-0.25.6,fabric-local --reps 3 \
      --vendor pi-fabric@0.25.6 --run-id myrun

Results land in `results/<run-id>/<config>/<task>/rep<N>/` in the same layout
as the trajectories repo; `analysis-summary.json` is written next to them.

## Official DeepSWE tasks through Pier

`run-deepswe-pier.sh` runs the same paired OMP configurations in the official
Harbor task images and separate verifier environment. Keep sibling checkouts of
`datacurve-ai/deep-swe` and `datacurve-ai/pier`, Docker running, and OMP
credentials in the active agent dir.

The Pier harness is not operational as shipped: it still stops on the
credential-isolation stub described below. The local matrix runs.

Credentials are no longer extracted or copied. Cells inherit the caller's agent
dir, so providers resolve exactly as they do in an interactive session, and the
arms are kept comparable with flags instead of a stripped directory. Set
`BENCH_AGENT_DIR` to opt into an isolated `PI_CODING_AGENT_DIR`; that directory
then needs its own authenticated `agent.db`. The Pier entry point still holds
the older stub and must be given the same treatment before it can run.

    PIER_ENVIRONMENT=modal ./run-deepswe-pier.sh bandit-interprocedural-taint-checks baseline
    PIER_ENVIRONMENT=modal ./run-deepswe-pier.sh bandit-interprocedural-taint-checks fabric-local

The matrix runner pins either the original reporter subset or a smaller adversarial cross-language canary, expands independent attempts through Pier, and gives both configurations deterministic resumable job names. Previewing is free; matrices over 24 paid cells require an explicit confirmation.

    PIER_DRY_RUN=1 ./run-deepswe-matrix.sh subsets/deepswe-canary-8.txt both
    PIER_ENVIRONMENT=modal PIER_CONFIRM_FULL_MATRIX=1 ./run-deepswe-matrix.sh subsets/deepswe-canary-8.txt both
    PIER_ENVIRONMENT=modal PIER_CONFIRM_FULL_MATRIX=1 ./run-deepswe-matrix.sh subsets/deepswe-36-v2.txt both

The defaults are three attempts and one concurrent trial. Override them with `PIER_N_ATTEMPTS`, `PIER_N_CONCURRENT`, and a stable `PIER_MATRIX_ID`; rerunning the same ID resumes Pier jobs with matching configs. The canary is 48 cells and the full reporter matrix is 216 cells, so use the canary before commissioning the full rerun.

Compare completed matched jobs and write replayable cell-level JSON with:

    python3 analyze_pier.py results/pier/<baseline-job> results/pier/<fabric-job> --output results/pier/<matrix-id>-comparison.json

The adapter installs OMP inside the task container, uploads only the isolated
OAuth/settings directory, and packs the current Fabric checkout for local runs.
Pier results land under `results/pier/`. In addition to verifier reward, the
trial metadata records fresh/cached/combined and peak context tokens, outer and nested
call mix, failures, same-file edit fragmentation, compactions, bounded versus
whole-file reads, model-visible result volume, and results over 50 KB. Pass additional `pier run` flags after the config, such as timeout multipliers or dataset sampling flags. For the launcher's standard repetition and concurrency controls, use `PIER_N_ATTEMPTS` and `PIER_N_CONCURRENT`. Modal is recommended on ARM hosts because the official images are amd64. Set `OMP_FABRIC_PACKAGE` to reuse one already-certified tarball across tasks. Run OAuth-backed cells serially.

Notes:

- The trajectories benchmark used `openai-codex/gpt-5.6-sol` at thinking `low`;
  reproduce it by setting `BENCH_MODEL` to that id. `result.json` records the
  model the session actually used, not the requested one.
- `combined_cost_usd` uses the provider-reported cost when the session records
  carry one, and the `BENCH_RATE_*` rates otherwise; `cost_source` says which.
- Run cells serially: shared provider rate limits, and OAuth-backed providers
  also race on refresh writes.
- `results/`, `.cache/`, `.runtime/` (if any) and `vendor/` are git-ignored.
