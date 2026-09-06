#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <task-slug|task-path|dataset-path> <baseline|fabric-local> [pier run args...]" >&2
  exit 2
fi

TARGET=$1
CONFIG=$2
shift 2

BENCH=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$BENCH/.." && pwd)
OPEN_SOURCE_ROOT=$(cd "$REPO_ROOT/.." && pwd)
PIER_ROOT=${PIER_ROOT:-$OPEN_SOURCE_ROOT/pier}
DEEPSWE_ROOT=${DEEPSWE_ROOT:-$OPEN_SOURCE_ROOT/deep-swe}
PIER_ENVIRONMENT=${PIER_ENVIRONMENT:-docker}
PIER_N_ATTEMPTS=${PIER_N_ATTEMPTS:-1}
PIER_N_CONCURRENT=${PIER_N_CONCURRENT:-1}

if ! [[ "$PIER_N_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PIER_N_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$PIER_N_CONCURRENT" =~ ^[1-9][0-9]*$ ]]; then
  echo "PIER_N_CONCURRENT must be a positive integer" >&2
  exit 2
fi

if [[ -d "$TARGET" ]]; then
  TASK_PATH=$(cd "$TARGET" && pwd)
elif [[ -d "$DEEPSWE_ROOT/tasks/$TARGET" ]]; then
  TASK_PATH="$DEEPSWE_ROOT/tasks/$TARGET"
else
  echo "DeepSWE task or dataset not found: $TARGET" >&2
  exit 2
fi
if [[ ! -f "$PIER_ROOT/pyproject.toml" ]]; then
  echo "Pier checkout not found at $PIER_ROOT" >&2
  exit 2
fi

RUNTIME="$BENCH/.runtime/pier-$CONFIG"
AGENT_DIR="$RUNTIME/agent"
ARTIFACT_DIR="$BENCH/.artifacts"
rm -rf "$RUNTIME"
mkdir -p "$AGENT_DIR" "$ARTIFACT_DIR" "$BENCH/results/pier"
chmod 700 "$RUNTIME" "$AGENT_DIR"

python3 - "$AGENT_DIR" <<'PY'
import json
import os
import sys

agent_dir = sys.argv[1]
source_dir = os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR", "~/.omp/agent"))
store = os.path.join(source_dir, "agent.db")
if not os.path.exists(store):
    raise SystemExit(f"no OMP credential store at {store}")
if not os.path.exists(os.path.join(agent_dir, "agent.db")):
    raise SystemExit(
        "this harness has no credential-isolation strategy yet.\n"
        + """OMP stores credentials in agent.db, not auth.json (removed upstream), so the
Pi-era single-entry extraction is impossible. Choose one and wire it here:
  1. omp --profile <name>  (host-native isolation for auth/sessions/settings/caches)
  2. copy the whole credential store with 'sqlite3 <src> "VACUUM INTO <dst>"'
     (consistent single file, no -wal/-shm siblings; copies every provider)"""
    )
with open(os.path.join(agent_dir, "settings.json"), "w") as handle:
    json.dump({
        "defaultModel": "gpt-5.6-sol",
        "defaultThinkingLevel": "low",
    }, handle)
PY
chmod 600 "$AGENT_DIR"/*.json

FABRIC_ARGS=()
case "$CONFIG" in
  baseline)
    ;;
  fabric-local)
    if [[ -n "${OMP_FABRIC_PACKAGE:-}" ]]; then
      FABRIC_PACKAGE=$(cd "$(dirname "$OMP_FABRIC_PACKAGE")" && pwd)/$(basename "$OMP_FABRIC_PACKAGE")
      if [[ ! -f "$FABRIC_PACKAGE" ]]; then
        echo "OMP_FABRIC_PACKAGE does not exist: $FABRIC_PACKAGE" >&2
        exit 2
      fi
    else
      rm -f "$ARTIFACT_DIR"/omp-fabric-*.tgz
      (
        cd "$REPO_ROOT"
        bun run build
        npm pack --ignore-scripts --pack-destination "$ARTIFACT_DIR"
      )
      PACKAGES=("$ARTIFACT_DIR"/omp-fabric-*.tgz)
      FABRIC_PACKAGE=${PACKAGES[0]}
    fi
    FABRIC_ARGS=(--agent-kwarg "fabric_package_path=$FABRIC_PACKAGE")
    ;;
  *)
    echo "unknown config: $CONFIG" >&2
    exit 2
    ;;
esac

if [[ "$PIER_ENVIRONMENT" == "docker" ]]; then
  if ! docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=$(command -v docker-compose || true)
    if [[ -z "$COMPOSE_BIN" ]]; then
      echo "Pier requires Docker Compose" >&2
      exit 2
    fi
    ACTIVE_CONTEXT=$(docker context show)
    DAEMON_HOST=$(docker context inspect "$ACTIVE_CONTEXT" --format '{{.Endpoints.docker.Host}}')
    DOCKER_CONFIG_DIR="$RUNTIME/docker-config"
    mkdir -p "$DOCKER_CONFIG_DIR/cli-plugins"
    ln -sf "$COMPOSE_BIN" "$DOCKER_CONFIG_DIR/cli-plugins/docker-compose"
    BUILDX_BIN=$(command -v docker-buildx || true)
    if [[ -n "$BUILDX_BIN" ]]; then
      ln -sf "$BUILDX_BIN" "$DOCKER_CONFIG_DIR/cli-plugins/docker-buildx"
    fi
    export DOCKER_CONFIG="$DOCKER_CONFIG_DIR"
    export DOCKER_HOST="$DAEMON_HOST"
  fi
  export DOCKER_DEFAULT_PLATFORM=${DOCKER_DEFAULT_PLATFORM:-linux/amd64}
  docker info >/dev/null
  docker compose version >/dev/null
fi

TASK_NAME=$(basename "$TASK_PATH")
JOB_NAME=${PIER_JOB_NAME:-"omp-$CONFIG-$TASK_NAME-$(date +%Y%m%d-%H%M%S)"}
export PYTHONPATH="$BENCH${PYTHONPATH:+:$PYTHONPATH}"

PIER_ARGS=(
  uv run --directory "$PIER_ROOT" pier run
  --path "$TASK_PATH"
  --agent-import-path pier_omp_agent:OMPCodingAgent
  --model openai-codex/gpt-5.6-sol
  --agent-kwarg "omp_agent_dir=$AGENT_DIR"
)
PIER_ARGS+=("${FABRIC_ARGS[@]}")
PIER_ARGS+=(
  --env "$PIER_ENVIRONMENT"
  --n-attempts "$PIER_N_ATTEMPTS"
  --n-concurrent "$PIER_N_CONCURRENT"
  --job-name "$JOB_NAME"
  --jobs-dir "$BENCH/results/pier"
  --yes
)
PIER_ARGS+=("$@")
"${PIER_ARGS[@]}"
