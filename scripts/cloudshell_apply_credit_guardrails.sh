#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"

echo "Applying credit-safe guardrail setup in $REGION."
echo "This script does not launch compute."

if [[ -n "${BUDGET_EMAIL:-}" ]]; then
  "$(dirname "$0")/cloudshell_create_budget.sh"
else
  echo "Skipping budget creation because BUDGET_EMAIL is not set."
  echo "Set BUDGET_EMAIL=you@example.com to enable budget alerts."
fi

G_QUOTA="$(aws service-quotas get-service-quota \
  --region "$REGION" \
  --service-code ec2 \
  --quota-code L-DB2E81BA \
  --query 'Quota.Value' \
  --output text 2>/dev/null || echo 0)"

echo "Current G/VT on-demand quota: $G_QUOTA vCPU"
if python3 - "$G_QUOTA" <<'PY'
import sys
sys.exit(0 if float(sys.argv[1]) >= 4 else 1)
PY
then
  echo "Quota is sufficient for g5.xlarge."
else
  G_VCPU_VALUE=4 P_VCPU_VALUE=0 "$(dirname "$0")/cloudshell_request_gpu_quota.sh"
fi

echo
echo "Current running/stopped EC2 instances in $REGION:"
aws ec2 describe-instances \
  --region "$REGION" \
  --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,State:State.Name,Type:InstanceType,Name:Tags[?Key==`Name`]|[0].Value}' \
  --output table || true

echo
echo "Guardrail setup complete. Deployment remains blocked until budget and quota checks pass."

