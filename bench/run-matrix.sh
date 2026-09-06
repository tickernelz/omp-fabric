#!/usr/bin/env bash
# Orchestrate a benchmark run: optional vendored old fabric, then cells per
# (task, config, rep). Serial by default so rate-limited providers see one
# in-flight agent at a time.
#
# Usage:
#   run-matrix.sh [--run-id ID] [--tasks slug,slug] [--configs a,b] [--reps N] [--vendor omp-fabric@0.25.6]
set -euo pipefail
BENCH="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
TASKS=""
CONFIGS="baseline,fabric-local"
REPS=1
VENDOR_PKG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --tasks) TASKS="$2"; shift 2 ;;
    --configs) CONFIGS="$2"; shift 2 ;;
    --reps) REPS="$2"; shift 2 ;;
    --vendor) VENDOR_PKG="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- vendored config (e.g. pi-fabric@0.25.6 = the version from the DeepSWE issue) ---
if [[ -n "$VENDOR_PKG" ]]; then
  PKG_NAME="${VENDOR_PKG%@*}"
  PKG_VERSION="${VENDOR_PKG##*@}"
  NAME="fabric-$PKG_VERSION"
  DEST="$BENCH/vendor/$NAME"
  if [[ ! -d "$DEST/node_modules/$PKG_NAME" ]]; then
    mkdir -p "$DEST"
    if ! (cd "$DEST" && npm init -y >/dev/null 2>&1 && npm install --legacy-peer-deps --no-audit --no-fund "$VENDOR_PKG" >/dev/null 2>&1); then
      echo "vendoring failed: npm install $VENDOR_PKG (is that name published?)" >&2
      exit 2
    fi
  fi
  if [[ ! -d "$DEST/node_modules/$PKG_NAME" ]]; then
    echo "vendoring failed: $VENDOR_PKG installed but $DEST/node_modules/$PKG_NAME is absent" >&2
    exit 2
  fi
  printf '%s\n' "$DEST/node_modules/$PKG_NAME" > "$DEST/extension-path"
  echo "vendored $VENDOR_PKG at $DEST/node_modules/$PKG_NAME"
fi

# --- agent dir ---
AGENT_DIR=${BENCH_AGENT_DIR:--}
if [[ "$AGENT_DIR" != "-" ]]; then
  mkdir -p "$AGENT_DIR"
  if [[ ! -f "$AGENT_DIR/agent.db" ]]; then
    echo "BENCH_AGENT_DIR=$AGENT_DIR has no agent.db; authenticate it first with:" >&2
    echo "  PI_CODING_AGENT_DIR=$AGENT_DIR omp auth login" >&2
    exit 2
  fi
fi
mkdir -p "$BENCH/results/$RUN_ID"

# --- task list ---
if [[ -z "$TASKS" ]]; then
  TASKS=$(ls "$BENCH/tasks" | paste -sd, -)
fi

MANIFEST="$BENCH/results/$RUN_ID/manifest.json"
echo "{\"run_id\": \"$RUN_ID\", \"tasks\": \"$TASKS\", \"configs\": \"$CONFIGS\", \"reps\": $REPS}" > "$MANIFEST"

IFS=',' read -ra TASK_ARR <<< "$TASKS"
IFS=',' read -ra CFG_ARR <<< "$CONFIGS"
for slug in "${TASK_ARR[@]}"; do
  for cfg in "${CFG_ARR[@]}"; do
    for ((rep = 0; rep < REPS; rep++)); do
      CELL="$BENCH/results/$RUN_ID/$cfg/$slug/rep$rep"
      echo "=== cell $slug / $cfg / rep$rep ==="
      "$BENCH/run-cell.sh" "$BENCH/tasks/$slug" "$cfg" "$rep" "$CELL" "$AGENT_DIR" \
        || echo "CELL FAILED: $slug $cfg rep$rep"
    done
  done
done

python3 "$BENCH/analyze.py" "$BENCH/results/$RUN_ID"
echo "run complete: $BENCH/results/$RUN_ID"
