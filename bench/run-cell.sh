#!/usr/bin/env bash
# Run one benchmark cell: fresh checkout of the task's base ref, one agent run,
# verifier, metric extraction. Mirrors the cell layout of
# github.com/Whamp/pi-fabric-deepswe-trajectories so the same analysis applies.
#
# Usage: run-cell.sh <task-dir> <config> <rep> <cell-out-dir> <agent-dir>
#   config: baseline | fabric-local | fabric-0.25.6
#   agent-dir: isolated PI_CODING_AGENT_DIR, or "-" to inherit the caller's
set -u

TASK_DIR="$1"
CONFIG="$2"
REP="$3"
CELL="$4"
AGENT_DIR="$5"

BENCH="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$BENCH/.." && pwd)"
TASK="$TASK_DIR/task.json"

SLUG=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['slug'])" "$TASK")
REPO_URL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['repo'])" "$TASK")
BASE_REF=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['base_ref'])" "$TASK")
AGENT_TIMEOUT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['agent_timeout_s'])" "$TASK")
VERIFY_TIMEOUT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['verify_timeout_s'])" "$TASK")

mkdir -p "$CELL/session-store" "$CELL/session" "$CELL/logs" "$CELL/artifacts"
WORKDIR="$CELL/workdir"

# --- fresh checkout at base ref ---
CACHE="$BENCH/.cache/$(basename "$REPO_URL" .git)"
if [[ ! -d "$CACHE/.git" ]]; then
  git clone "$REPO_URL" "$CACHE" >/dev/null 2>&1
fi
git -C "$CACHE" fetch --quiet origin >/dev/null 2>&1 || true
git clone --quiet "$CACHE" "$WORKDIR"
# pin the task's base state: local main/master == base ref so agents that
# "branch from main" (per DeepSWE prompts) start from the right tree
git -C "$WORKDIR" branch -f master "$BASE_REF" 2>/dev/null || true
git -C "$WORKDIR" branch -f main "$BASE_REF" 2>/dev/null || true
git -C "$WORKDIR" checkout --quiet "$BASE_REF"

# --- config flags ---
BENCH_MODEL=${BENCH_MODEL:-}
BENCH_THINKING=${BENCH_THINKING:-low}
BENCH_OMP_CONFIG=${BENCH_OMP_CONFIG:-}
COMMON_FLAGS=(--print --thinking "$BENCH_THINKING" --session-dir "$CELL/session-store" --no-rules --no-skills --no-extensions)
if [[ -n "$BENCH_MODEL" ]]; then
  COMMON_FLAGS+=(--model "$BENCH_MODEL")
fi
if [[ -n "$BENCH_OMP_CONFIG" ]]; then
  COMMON_FLAGS+=(--config "$BENCH_OMP_CONFIG")
fi
case "$CONFIG" in
  baseline)
    CFG_FLAGS=()
    ;;
  fabric-local)
    CFG_FLAGS=(-e "$REPO_ROOT")
    ;;
  fabric-*)
    VENDOR_MARKER="$BENCH/vendor/$CONFIG/extension-path"
    if [[ -f "$VENDOR_MARKER" ]]; then
      VENDOR="$(cat "$VENDOR_MARKER")"
    else
      VENDOR="$BENCH/vendor/$CONFIG/node_modules/omp-fabric"
    fi
    if [[ ! -d "$VENDOR" ]]; then
      echo "missing vendored extension: $VENDOR (see bench/run-matrix.sh vendor step)" >&2
      exit 2
    fi
    CFG_FLAGS=(-e "$VENDOR")
    ;;
  *) echo "unknown config: $CONFIG" >&2; exit 2 ;;
esac

# --- agent run with watchdog timeout (macOS lacks GNU timeout) ---
cd "$WORKDIR" || { echo "cannot enter workdir: $WORKDIR" >&2; exit 1; }
START=$(python3 -c 'import time;print(time.time())')
PROMPT="$(cat "$TASK_DIR/prompt.txt")"
if [[ "$AGENT_DIR" == "-" ]]; then
  AGENT_DIR_ENV=()
else
  AGENT_DIR_ENV=(env "PI_CODING_AGENT_DIR=$AGENT_DIR")
fi
(
  "${AGENT_DIR_ENV[@]}" omp "${COMMON_FLAGS[@]}" "${CFG_FLAGS[@]}" "$PROMPT" \
    >"$CELL/logs/omp.stdout.txt" 2>"$CELL/logs/omp.stderr.txt" &
  AGENT_PID=$!
  ( sleep "$AGENT_TIMEOUT"; kill -TERM $AGENT_PID 2>/dev/null; sleep 20; kill -KILL $AGENT_PID 2>/dev/null ) &
  WATCHDOG=$!
  wait $AGENT_PID; AGENT_EXIT=$?
  kill $WATCHDOG 2>/dev/null
  echo "$AGENT_EXIT" > "$CELL/agent-exit-code.txt"
)
END=$(python3 -c 'import time;print(time.time())')
WALL=$(python3 -c "print(round($END - $START, 1))")

# session artifacts
find "$CELL/session-store" -name '*.jsonl' -exec cp {} "$CELL/session/" \; 2>/dev/null || true

# --- patch artifact ---
git -C "$WORKDIR" add -A >/dev/null 2>&1
git -C "$WORKDIR" diff --cached "$BASE_REF" -- . ':(exclude)vendor/**' ':(exclude)**/node_modules/**' ':(exclude).verify-bin/**' ':(exclude).verify-out/**' > "$CELL/artifacts/model.patch" 2>/dev/null
(git -C "$WORKDIR" ls-files --cached -- 'vendor/*' '*/node_modules/*' | sed -e 's/.*/[vendored dependency paths omitted from patch]/' | head -1 >> "$CELL/artifacts/model.patch" 2>/dev/null) || true

# --- metrics from session jsonl ---
python3 - "$CELL" "$WALL" "$BENCH_THINKING" "$BENCH_MODEL" <<'PYEOF'
import json, glob, os, sys
cell, wall = sys.argv[1], float(sys.argv[2])
thinking, requested_model = sys.argv[3], sys.argv[4]
turns = 0; tool_calls = 0
models = []
tot = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}
cost_seen = 0.0
for f in glob.glob(os.path.join(cell, "session", "*.jsonl")):
    for line in open(f, errors="replace"):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message", {})
        if msg.get("role") != "assistant":
            continue
        turns += 1
        seen_model = msg.get("model") or rec.get("model")
        if seen_model and seen_model not in models:
            models.append(seen_model)
        u = msg.get("usage") or {}
        for k in tot:
            tot[k] += int(u.get(k) or 0)
        c = (u.get("cost") or {}).get("total")
        if c: cost_seen += float(c)
        for item in msg.get("content", []):
            if isinstance(item, dict) and item.get("type") == "toolCall":
                tool_calls += 1
RATES = {
    "input": float(os.environ.get("BENCH_RATE_INPUT", 5.0)),
    "cached": float(os.environ.get("BENCH_RATE_CACHED", 0.50)),
    "output": float(os.environ.get("BENCH_RATE_OUTPUT", 30.0)),
}
fresh = tot["input"] + tot["cacheWrite"]
estimated = (fresh * RATES["input"] + tot["cacheRead"] * RATES["cached"] + tot["output"] * RATES["output"]) / 1e6
cost = cost_seen if cost_seen else estimated
patch_path = os.path.join(cell, "artifacts", "model.patch")
patch_bytes = os.path.getsize(patch_path) if os.path.exists(patch_path) else 0
result = {
    "model": models[0] if models else (requested_model or "unresolved"),
    "models_seen": models,
    "thinking_level": thinking,
    "cost_source": "reported" if cost_seen else "estimated",
    "cost_usd_estimated": round(estimated, 4),
    "combined_total_tokens": tot["totalTokens"],
    "tokens_fresh_input": fresh,
    "tokens_cached_input": tot["cacheRead"],
    "tokens_output": tot["output"],
    "combined_cost_usd": round(cost, 4),
    "cost_usd_reported": round(cost_seen, 4),
    "agent_wall_s": wall,
    "turns": turns,
    "tool_calls": tool_calls,
    "patch_bytes": patch_bytes,
}
json.dump(result, open(os.path.join(cell, "result.json"), "w"), indent=2)
PYEOF

# --- verifier ---
if [[ -x "$TASK_DIR/verify.sh" ]]; then
  (
    cd "$WORKDIR"
    ( "$TASK_DIR/verify.sh" "$WORKDIR" "$CELL/result.json" >"$CELL/logs/verify.stdout.txt" 2>"$CELL/logs/verify.stderr.txt" &
      VPID=$!
      ( sleep "$VERIFY_TIMEOUT"; kill -TERM $VPID 2>/dev/null; sleep 10; kill -KILL $VPID 2>/dev/null ) &
      WD=$!
      wait $VPID 2>/dev/null
      kill $WD 2>/dev/null
    )
  )
fi
echo "cell done: $SLUG $CONFIG rep$REP -> $CELL"
cat "$CELL/result.json"
