#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${AWS_STACK_NAME:-voice-agent-vllm}"
aws cloudformation delete-stack --stack-name "$STACK_NAME"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
