#!/usr/bin/env bash
# Orchestrate a benchmark run: isolated agent dir, optional vendored old fabric,
# then cells per (task, config, rep). Serial by default to avoid OAuth refresh
# races on the shared codex token.
#
# Usage:
#   run-matrix.sh [--run-id ID] [--tasks slug,slug] [--configs a,b] [--reps N] [--vendor omp-fabric@0.25.6]
set -u
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

# --- isolated agent dir ---
AGENT_DIR="$BENCH/results/$RUN_ID/agent"
mkdir -p "$AGENT_DIR"
python3 - "$AGENT_DIR" <<'PYEOF'
import json, os, sys
dst = sys.argv[1]
source_dir = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR", "~/.omp/agent"))
store = os.path.join(source_dir, "agent.db")
if not os.path.exists(store):
    raise SystemExit(f"no OMP credential store at {store}")
if not os.path.exists(os.path.join(dst, "agent.db")):
    raise SystemExit(
        "this harness has no credential-isolation strategy yet.\n"
        + """OMP stores credentials in agent.db, not auth.json (removed upstream), so the
Pi-era single-entry extraction is impossible. Choose one and wire it here:
  1. omp --profile <name>  (host-native isolation for auth/sessions/settings/caches)
  2. copy the whole credential store with 'sqlite3 <src> "VACUUM INTO <dst>"'
     (consistent single file, no -wal/-shm siblings; copies every provider)"""
    )
json.dump({"defaultModel": "gpt-5.6-sol", "defaultThinkingLevel": "low"},
          open(os.path.join(dst, "settings.json"), "w"), indent=2)
print("agent dir prepared:", dst)
PYEOF

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
