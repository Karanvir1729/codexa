# Head Developer MCP Server

This service exposes Cloud Orchestrator actions as MCP tools. It is the structured action layer between the Head Developer model and the product runtime.

Run locally:

```bash
npm run mcp:server
```

The server uses stdio transport and exposes:

- `create_project`
- `create_task`
- `launch_worker`
- `run_codex_task`
- `run_command`
- `inspect_task_state`
- `inspect_worker`
- `stop_worker`
- `generate_task_summary`
- `request_approval`
- `list_gcp_workers`
- `cleanup_expired_workers`

Every tool call writes an MCP action record and corresponding orchestrator event. The flowchart renders those records as `mcp_action` nodes.

## Google MCP Servers

External Google MCP servers should be connected by the MCP host/client, not by hardcoding credentials in this server.

Useful Google MCP endpoints and setup:

- Google Cloud MCP overview: https://docs.cloud.google.com/mcp
- Compute Engine MCP endpoint: `https://compute.googleapis.com/mcp`
- Developer Knowledge MCP enablement:

```bash
gcloud beta services mcp enable developerknowledge.googleapis.com --project="$GCP_PROJECT_ID"
```

For GCP resource operations, prefer Google-managed MCP tools when the host has them configured. Use raw `gcloud` or client libraries only when MCP support is missing, lower-level startup control is required, or MCP infrastructure is being bootstrapped.

## Safety

- MCP calls are not a side door. They are logged in the same event store used by the dashboard.
- `run_command` always goes through `CommandRunner` and command policy.
- `cleanup_expired_workers` stops expired workers but does not delete VMs; deletion remains an explicit cleanup-script path until approval wiring supports destructive MCP actions.
- Tools redact token, secret, credential, password, authorization, and API key shaped input fields before logging.
