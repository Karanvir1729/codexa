#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y python3-pip python3-venv git

python3 -m venv /opt/vllm
/opt/vllm/bin/pip install --upgrade pip
/opt/vllm/bin/pip install "vllm==0.9.2"

cat >/etc/systemd/system/vllm.service <<'SERVICE'
[Unit]
Description=vLLM OpenAI-compatible NVIDIA Nemotron server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HF_HOME=/opt/huggingface
Environment=HF_TOKEN=${HF_TOKEN}
ExecStart=/opt/vllm/bin/python -m vllm.entrypoints.openai.api_server \
  --model "${MODEL_ID}" \
  --trust-remote-code \
  --seed=1 \
  --host=0.0.0.0 \
  --port=5000 \
  --served-model-name "${SERVED_MODEL_NAME}" \
  --tensor-parallel-size=${TENSOR_PARALLEL_SIZE} \
  --max-model-len=${MAX_MODEL_LEN} \
  --gpu-memory-utilization=0.95 \
  --enforce-eager
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now vllm

