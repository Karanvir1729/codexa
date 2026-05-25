#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-credit-safe}"

case "$PROFILE" in
  credit-safe)
    export INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
    export MODEL_ID="${MODEL_ID:-nvidia/Llama-3.1-Nemotron-Nano-8B-v1}"
    export SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Llama-3.1-Nemotron-Nano-8B-v1}"
    export TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
    export MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
    export AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-4}"
    ;;
  short-49b)
    if [[ "${ALLOW_EXPENSIVE_PROFILE:-false}" != "true" ]]; then
      echo "short-49b is not credit-safe. Set ALLOW_EXPENSIVE_PROFILE=true to run it deliberately." >&2
      exit 1
    fi
    export INSTANCE_TYPE="${INSTANCE_TYPE:-g6e.12xlarge}"
    export MODEL_ID="${MODEL_ID:-nvidia/Llama-3_3-Nemotron-Super-49B-v1_5}"
    export SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Llama-3_3-Nemotron-Super-49B-v1_5}"
    export TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-4}"
    export MAX_MODEL_LEN="${MAX_MODEL_LEN:-32768}"
    export AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-2}"
    ;;
  *)
    echo "Unknown profile: $PROFILE" >&2
    echo "Use: credit-safe | short-49b" >&2
    exit 1
    ;;
esac

exec "$(dirname "$0")/cloudshell_deploy_vllm.sh"
