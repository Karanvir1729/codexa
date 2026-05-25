# Cost Guardrails

AWS credits reduce net spend, but they are not an API-level deny switch. AWS Budgets
alerts can be delayed, and usage can continue after a budget threshold is crossed before
notifications or actions run.

Current guardrails:

- Local default provider is `mock`, so development makes no paid model calls.
- GPU deployment uses `g5.xlarge`, NVIDIA `Llama-3.1-Nemotron-Nano-8B-v1`, and 4-hour auto-stop.
- Deploy script refuses non-`g5.xlarge` profiles unless `ALLOW_EXPENSIVE_PROFILE=true`.
- Deploy script refuses to run unless the budget guardrail exists or `BUDGET_EMAIL` is provided.
- Deploy script refuses to run if `Running On-Demand G and VT instances` quota is below 4 vCPU.
- The current CloudShell session is root, so IAM policies cannot technically prevent root from spending.

Credit-safe setup:

```bash
BUDGET_EMAIL=you@example.com ./scripts/cloudshell_apply_credit_guardrails.sh
./scripts/cloudshell_deploy_profiles.sh credit-safe
```

Emergency stop:

```bash
./scripts/cloudshell_destroy_vllm.sh
```

