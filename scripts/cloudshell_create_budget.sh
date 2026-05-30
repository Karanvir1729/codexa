#!/usr/bin/env bash
set -euo pipefail

: "${BUDGET_EMAIL:?Set BUDGET_EMAIL to receive budget alerts}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUDGET_NAME="${BUDGET_NAME:-voice-agent-credit-guard}"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-100}"

cat > /tmp/voice-agent-budget.json <<EOF
{
  "BudgetName": "$BUDGET_NAME",
  "BudgetLimit": {
    "Amount": "$BUDGET_AMOUNT",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "TagKeyValue": ["user:Project$voice-agent-feedback-engine"]
  }
}
EOF

cat > /tmp/voice-agent-budget-notifications.json <<EOF
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 50,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      {
        "SubscriptionType": "EMAIL",
        "Address": "$BUDGET_EMAIL"
      }
    ]
  },
  {
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 90,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      {
        "SubscriptionType": "EMAIL",
        "Address": "$BUDGET_EMAIL"
      }
    ]
  }
]
EOF

aws budgets create-budget \
  --account-id "$ACCOUNT_ID" \
  --budget file:///tmp/voice-agent-budget.json \
  --notifications-with-subscribers file:///tmp/voice-agent-budget-notifications.json

echo "Created budget $BUDGET_NAME for $BUDGET_AMOUNT USD. Confirm the email subscription if AWS sends a confirmation email."
