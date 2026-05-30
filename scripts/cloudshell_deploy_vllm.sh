#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_NAME="${AWS_STACK_NAME:-voice-agent-vllm}"

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$ROOT_DIR/infra/aws/cloudformation-vllm.yml" \
  --capabilities CAPABILITY_NAMED_IAM
