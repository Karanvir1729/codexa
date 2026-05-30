# Cekura Voice Agent Testing

This project uses Cekura for external regression testing of the browser voice coding agent.

## MCP Connection

Use the Cekura MCP server when it is available in Codex. For API-key auth:

```bash
codex mcp add cekura --env CEKURA_API_KEY=YOUR_API_KEY_HERE -- \
  sh -c 'npx -y mcp-remote https://api.cekura.ai/mcp --header "X-CEKURA-API-KEY:$CEKURA_API_KEY"'
```

Do not commit Cekura API keys. Keep them in `.env.local`, shell environment, or CI secrets.

## Project Details

- Project ID: `5817`
- Agent ID: `18023`
- Agent name: `Voice Agent Feedback Engine`
- Provider: self-hosted Custom WebSocket chat
- WebSocket path: `/api/cekura/ws`
- Local status endpoint: `/api/cekura/status`
- Evaluator catalog: `config/cekura/evaluators.json`
- Repo sync/run script: `scripts/cekura_testing.py`

## Common Workflows

List current Cekura state:

```bash
./scripts/run_cekura.sh status
```

Create or update the Cekura agent and 10 regression evaluators:

```bash
export CEKURA_WEBSOCKET_URL=wss://<public-backend-host>/api/cekura/ws
./scripts/run_cekura.sh sync
```

Run the external suite and wait for completion:

```bash
./scripts/run_cekura.sh run --wait --frequency 1
```

Triage the latest result:

```bash
./scripts/run_cekura.sh triage
```

## Runtime Notes

Cekura text-mode runs connect to `/api/cekura/ws`. Each Cekura message is routed through `run_voice_text_turn`, which records assumed-STT voice turns, latency traces, runtime actions, flow state, and prompt version metadata in SQLite.

Completed Cekura result webhooks should post to `/api/cekura/hooks/result`. The backend stores those runs in `eval_runs` and `eval_results`, making failures visible in `/api/self-learn`.

Use `X-CEKURA-SECRET` or `X-VOCERA-SECRET` headers when `CEKURA_WEBHOOK_SECRET` or `CEKURA_WEBSOCKET_SECRET` are configured.
