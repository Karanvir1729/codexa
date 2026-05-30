#!/usr/bin/env bash
set -euxo pipefail

MODEL_ID="${MODEL_ID:-nvidia/Llama-3.1-Nemotron-Nano-8B-v1}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-$MODEL_ID}"

apt-get update
apt-get install -y python3-pip
pip3 install --upgrade vllm

python3 -m vllm.entrypoints.openai.api_server \
  --host 0.0.0.0 \
  --port 5000 \
  --model "$MODEL_ID" \
  --served-model-name "$SERVED_MODEL_NAME"
