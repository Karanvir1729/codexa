# Secret Manager Plan

Use Secret Manager for credentials. Store names in config and inject values through Cloud Run secret mounts or environment bindings.

## Secret Names

- `twilio-auth-token`
- `twilio-account-sid`
- `twilio-phone-number-sid`
- `openai-api-key`
- `codex-api-key`
- `github-token`
- `vertex-service-account-json` if workload identity is unavailable
- `nvidia-nim-api-key`
- `ngc-api-key` if using NGC-hosted NIM containers

## Rules

- Never print secret values.
- Never commit `.env` files.
- Scripts may list secret names for readiness only.
- Secret creation or updates require `DEPLOY_CONFIRM=yes`.
- GCP VM Codex workers use `codex-api-key` at runtime through Secret Manager and `codex login --with-api-key`; do not copy a local `.codex/auth.json` to GCP.
- Twilio webhook mutation requires an application-level approval event and audit log entry.
