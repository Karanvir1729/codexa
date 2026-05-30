#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
STACK_NAME="${STACK_NAME:-voice-agent-vllm}"

echo "Deleting $STACK_NAME in $REGION. This stops and removes the GPU instance."
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK_NAME"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK_NAME"
echo "Deleted $STACK_NAME"

