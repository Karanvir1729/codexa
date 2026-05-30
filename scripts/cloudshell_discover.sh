#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
STACK_NAME="${STACK_NAME:-voice-agent-vllm}"
OUT_DIR="${OUT_DIR:-/tmp/voice-agent-discovery}"
mkdir -p "$OUT_DIR"

echo "Region: $REGION"
echo "Caller:"
aws sts get-caller-identity --output table

echo
echo "Default VPC:"
VPC_ID="$(aws ec2 describe-vpcs \
  --region "$REGION" \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"
echo "$VPC_ID"

echo
echo "Candidate public subnets:"
aws ec2 describe-subnets \
  --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`].[SubnetId,AvailabilityZone,AvailableIpAddressCount]' \
  --output table

SUBNET_ID="$(aws ec2 describe-subnets \
  --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`]|[0].SubnetId' \
  --output text)"

echo
echo "Latest DLAMI:"
AMI_ID="$(aws ssm get-parameter \
  --region "$REGION" \
  --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-24.04/latest/ami-id \
  --query 'Parameter.Value' \
  --output text)"
echo "$AMI_ID"

echo
echo "GPU on-demand quota snapshot:"
aws service-quotas list-service-quotas \
  --region "$REGION" \
  --service-code ec2 \
  --query 'Quotas[?contains(QuotaName, `Running On-Demand`) && (contains(QuotaName, `G and VT`) || contains(QuotaName, `P instances`) || contains(QuotaName, `P5`) || contains(QuotaName, `G instances`))].[QuotaName,Value,QuotaCode]' \
  --output table || true

echo
echo "Estimated deploy variables:"
MY_IP="$(curl -fsS https://checkip.amazonaws.com || true)"
cat >"$OUT_DIR/deploy.env" <<EOF
AWS_REGION=$REGION
STACK_NAME=$STACK_NAME
VPC_ID=$VPC_ID
SUBNET_ID=$SUBNET_ID
ALLOWED_CIDR=${MY_IP:-0.0.0.0}/32
AMI_ID=$AMI_ID
INSTANCE_TYPE=g5.xlarge
MODEL_ID=nvidia/Llama-3.1-Nemotron-Nano-8B-v1
SERVED_MODEL_NAME=Llama-3.1-Nemotron-Nano-8B-v1
TENSOR_PARALLEL_SIZE=1
MAX_MODEL_LEN=8192
AUTO_STOP_HOURS=4
EOF

cat "$OUT_DIR/deploy.env"
echo
echo "Wrote $OUT_DIR/deploy.env"
