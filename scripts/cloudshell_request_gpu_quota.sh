#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
G_VCPU_VALUE="${G_VCPU_VALUE:-4}"
P_VCPU_VALUE="${P_VCPU_VALUE:-0}"

cat <<EOF
This requests GPU EC2 quota increases in $REGION. It does not launch instances or spend money,
but it enables future GPU spend if AWS approves the request.

Requested:
  Running On-Demand G and VT instances: $G_VCPU_VALUE vCPU
  Running On-Demand P instances:        $P_VCPU_VALUE vCPU, skipped when 0

Press Ctrl-C now if you do not want quota requests submitted.
EOF
sleep 10

aws service-quotas request-service-quota-increase \
  --region "$REGION" \
  --service-code ec2 \
  --quota-code L-DB2E81BA \
  --desired-value "$G_VCPU_VALUE" \
  --output table || true

if [[ "$P_VCPU_VALUE" != "0" ]]; then
  aws service-quotas request-service-quota-increase \
    --region "$REGION" \
    --service-code ec2 \
    --quota-code L-417A185B \
    --desired-value "$P_VCPU_VALUE" \
    --output table || true
fi

echo
echo "Open requests:"
aws service-quotas list-requested-service-quota-change-history-by-quota \
  --region "$REGION" \
  --service-code ec2 \
  --quota-code L-DB2E81BA \
  --query 'RequestedQuotas[:5].[Id,Status,DesiredValue,Created]' \
  --output table || true

aws service-quotas list-requested-service-quota-change-history-by-quota \
  --region "$REGION" \
  --service-code ec2 \
  --quota-code L-417A185B \
  --query 'RequestedQuotas[:5].[Id,Status,DesiredValue,Created]' \
  --output table || true
