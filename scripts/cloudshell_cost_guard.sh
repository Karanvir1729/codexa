#!/usr/bin/env bash
set -euo pipefail

CAP_USD="${AWS_SPEND_CAP_USD:-95}"
ESTIMATED_NEW_COST_USD="${ESTIMATED_NEW_COST_USD:-0}"
METRIC="${AWS_COST_METRIC:-UnblendedCost}"

DATES="$(python3 - <<'PY'
from datetime import date, timedelta
today = date.today()
start = today.replace(day=1)
end = today + timedelta(days=1)
print(start.isoformat(), end.isoformat())
PY
)"
START_DATE="${DATES%% *}"
END_DATE="${DATES##* }"

echo "Checking AWS month-to-date spend before continuing."
echo "Metric: $METRIC"
echo "Window: $START_DATE to $END_DATE"
echo "Configured cap: \$$CAP_USD"
echo "Estimated new cost: \$$ESTIMATED_NEW_COST_USD"

if ! COST_JSON="$(aws ce get-cost-and-usage \
  --region us-east-1 \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --metrics "$METRIC" \
  --output json 2>&1)"; then
  echo "Unable to read AWS Cost Explorer. Refusing to continue because spend cannot be checked." >&2
  echo "$COST_JSON" >&2
  echo "Cost Explorer data can lag by about 24 hours and the API request may incur a small AWS charge." >&2
  exit 1
fi

CURRENT_USD="$(COST_JSON="$COST_JSON" python3 - "$METRIC" <<'PY'
import json
import os
import sys

metric = sys.argv[1]
data = json.loads(os.environ["COST_JSON"])
amount = 0.0
for item in data.get("ResultsByTime", []):
    total = item.get("Total", {}).get(metric, {})
    amount += float(total.get("Amount", 0) or 0)
print(f"{amount:.6f}")
PY
)"

python3 - "$CURRENT_USD" "$ESTIMATED_NEW_COST_USD" "$CAP_USD" <<'PY'
import sys

current = float(sys.argv[1])
new = float(sys.argv[2])
cap = float(sys.argv[3])
after = current + new
print(f"Current month-to-date cost: ${current:.6f}")
print(f"Projected after this action: ${after:.6f}")
if after > cap:
    print(
        f"Refusing to continue: projected ${after:.6f} exceeds configured cap ${cap:.2f}.",
        file=sys.stderr,
    )
    sys.exit(1)
PY

echo "AWS spend guard passed."
