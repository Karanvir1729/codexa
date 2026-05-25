#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
STACK_NAME="${STACK_NAME:-voice-agent-vllm}"
TEMPLATE_FILE="${TEMPLATE_FILE:-infra/aws/cloudformation-vllm.yml}"

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Missing $TEMPLATE_FILE. Run from the repository root or upload the template to CloudShell." >&2
  exit 1
fi

: "${VPC_ID:?Set VPC_ID}"
: "${SUBNET_ID:?Set SUBNET_ID}"
: "${ALLOWED_CIDR:?Set ALLOWED_CIDR, e.g. 203.0.113.10/32}"

INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
MODEL_ID="${MODEL_ID:-nvidia/Llama-3.1-Nemotron-Nano-8B-v1}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Llama-3.1-Nemotron-Nano-8B-v1}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-4}"
HUGGINGFACE_TOKEN="${HUGGINGFACE_TOKEN:-}"
REQUIRE_BUDGET="${REQUIRE_BUDGET:-true}"

if [[ "$INSTANCE_TYPE" != "g5.xlarge" && "${ALLOW_EXPENSIVE_PROFILE:-false}" != "true" ]]; then
  echo "Refusing to deploy $INSTANCE_TYPE without ALLOW_EXPENSIVE_PROFILE=true." >&2
  echo "Use g5.xlarge for the $100-credit profile." >&2
  exit 1
fi

if [[ "$REQUIRE_BUDGET" == "true" ]]; then
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  if ! aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name voice-agent-credit-guard >/dev/null 2>&1; then
    if [[ -n "${BUDGET_EMAIL:-}" ]]; then
      BUDGET_EMAIL="$BUDGET_EMAIL" "$(dirname "$0")/cloudshell_create_budget.sh"
    else
      echo "Refusing to deploy until budget guardrail exists." >&2
      echo "Run: BUDGET_EMAIL=you@example.com ./scripts/cloudshell_create_budget.sh" >&2
      exit 1
    fi
  fi
fi

G_QUOTA="$(aws service-quotas get-service-quota \
  --region "$REGION" \
  --service-code ec2 \
  --quota-code L-DB2E81BA \
  --query 'Quota.Value' \
  --output text 2>/dev/null || echo 0)"
if python3 - "$G_QUOTA" <<'PY'
import sys
sys.exit(0 if float(sys.argv[1]) >= 4 else 1)
PY
then
  true
else
  echo "Refusing to deploy: Running On-Demand G and VT quota is $G_QUOTA vCPU, need at least 4 for g5.xlarge." >&2
  echo "Run: ./scripts/cloudshell_request_gpu_quota.sh" >&2
  exit 1
fi

cat <<EOF
About to create/update CloudFormation stack:
  Stack: $STACK_NAME
  Region: $REGION
  Instance: $INSTANCE_TYPE
  Model: $MODEL_ID
  Allowed CIDR: $ALLOWED_CIDR
  Auto-stop: ${AUTO_STOP_HOURS}h

This launches GPU EC2 capacity that should draw from AWS credits if credits are active.
The instance is configured to stop automatically after ${AUTO_STOP_HOURS}h.
Press Ctrl-C now if this is not intended.
EOF
sleep 10

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE_FILE" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    SubnetId="$SUBNET_ID" \
    AllowedCidr="$ALLOWED_CIDR" \
    InstanceType="$INSTANCE_TYPE" \
    ModelId="$MODEL_ID" \
    ServedModelName="$SERVED_MODEL_NAME" \
    TensorParallelSize="$TENSOR_PARALLEL_SIZE" \
    MaxModelLen="$MAX_MODEL_LEN" \
    AutoStopHours="$AUTO_STOP_HOURS" \
    HuggingFaceToken="$HUGGINGFACE_TOKEN"

aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table
