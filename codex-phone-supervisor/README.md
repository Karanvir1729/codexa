# Codex Phone Supervisor

Local prototype for supervising Codex over a phone-style voice interface.

## What it does

- Starts Codex tasks with `codex exec --json`
- Stores raw event output and a normalized session state
- Answers phone-style questions about Codex state
- Gates risky actions behind explicit approval
- Shows a minimal dashboard for status, events, approvals, touched files, commands, and summaries
- Supports four connection modes: in-app mic voice, in-app text chat, Twilio SMS, and Twilio phone calls
- Can use Vertex AI Gemini for project routing, summarization, and risk classification when `SUPERVISOR_MODEL_PROVIDER=vertex`
- Can use Google Cloud Conversational Agents / Dialogflow CX for managed conversation and summarization when `SUPERVISOR_MODEL_PROVIDER=gcp_conversation_ai`
- Can use a self-hosted NVIDIA NIM/OpenAI-compatible endpoint on Compute Engine when `SUPERVISOR_MODEL_PROVIDER=nvidia_nim`

## File structure

```text
codex-phone-supervisor/
  backend/src/
  frontend/
  scripts/
  tests/
  tsconfig.json
```

## Setup

Run commands from the repository root.

1. Install dependencies:

```bash
npm install
```

2. Create explicit runtime config:

```bash
cp .env.example .env
```

Edit `.env` before starting the app. The supervisor intentionally does not silently infer ports, Codex paths, workspace paths, project roots, origins, or Twilio URLs.

For local overrides that should take precedence over legacy repo `.env` values, create `.env.codex-phone-supervisor`. That file is gitignored and loaded after `.env`.

3. Start the backend:

```bash
npm run dev:backend
```

4. In another terminal, start the frontend:

```bash
npm run dev:frontend
```

5. Open the dashboard:

```text
Use the origin configured in CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS.
```

## Demo

Run the demo script with the backend already running:

```bash
npm run demo
```

## CLI phone simulator

```bash
npm run phone -- <session_id> "what changed?"
```

## Four connection modes

All modes converge on the same supervisor intent router and approval firewall.
Before coding starts, the chat runs a Codex-backed project-selection flow. It asks a short follow-up when the project is unclear, then attaches the session to a selected workspace under `CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS`.

```text
1. Voice chat in app via computer mic
   Browser SpeechRecognition + SpeechSynthesis, then POST /call/message

2. Text chat in app via computer
   Dashboard text chat, then POST /call/message

3. Twilio text chat
   Inbound SMS webhook, then POST /twilio/sms

4. Twilio phone call
   Twilio Voice webhook + ConversationRelay websocket
   POST /twilio/voice and /twilio/conversation-relay
```

The phone, SMS, mic, and app text layers never run shell commands directly. They only call the backend supervisor tools.

## Vertex AI Gemini

Use `SUPERVISOR_MODEL_PROVIDER=vertex` for the high-level supervisor model. Vertex handles project routing, concise summaries, and risk classification. It never executes shell commands directly; Codex work still goes through the backend Codex adapter and approval firewall.

Required config:

```bash
SUPERVISOR_MODEL_PROVIDER=vertex
VERTEX_PROJECT_ID=your-project-id
VERTEX_LOCATION=us-central1
VERTEX_MODEL=gemini-2.5-flash
```

The local machine must have Google Application Default Credentials or a service account available for Vertex AI. The current local override file uses Vertex for the supervisor and an explicit Codex CLI binary path.

## GCP Conversation AI

Use `SUPERVISOR_MODEL_PROVIDER=gcp_conversation_ai` when Google Cloud Conversational Agents / Dialogflow CX should handle project-selection dialog, summarization prompts, or risk-classification prompts.

Required config:

```bash
SUPERVISOR_MODEL_PROVIDER=gcp_conversation_ai
GCP_CONVERSATION_PROJECT_ID=your-project-id
GCP_CONVERSATION_LOCATION=us-central1
GCP_CONVERSATION_AGENT_ID=your-dialogflow-cx-agent-id
GCP_CONVERSATION_LANGUAGE_CODE=en-US
GCP_CONVERSATION_API_ENDPOINT=us-central1-dialogflow.googleapis.com
GCP_CONVERSATION_ENVIRONMENT_ID=
```

The configured GCP agent must return concise text for normal conversation and JSON for structured project-routing tasks when prompted. It must not execute tools directly; all Codex actions still go through backend supervisor tools and approval checks.

## NVIDIA NIM On Compute Engine

Use `SUPERVISOR_MODEL_PROVIDER=nvidia_nim` when a GPU VM hosts an NVIDIA NIM or another OpenAI-compatible inference server for summarization, project routing, and risk-classification prompts.

Required config:

```bash
SUPERVISOR_MODEL_PROVIDER=nvidia_nim
NVIDIA_NIM_BASE_URL=https://your-nim-host/v1
NVIDIA_NIM_MODEL=nvidia/your-model
NVIDIA_NIM_API_KEY=secret-value-from-secret-manager-or-env
NVIDIA_NIM_ALLOW_INSECURE_HTTP=0
```

If the endpoint is internal `http://`, set `NVIDIA_NIM_ALLOW_INSECURE_HTTP=1` explicitly. The NVIDIA model still cannot run Codex or shell commands directly; it only returns supervisor text or structured routing decisions.

## Real phone and SMS integration

The real telephony path uses Twilio as the phone/SMS bridge. The bridge is intentionally separate from the Codex execution layer: it can only call the supervisor tools `get_codex_status`, `get_codex_events`, `get_codex_summary`, `send_codex_instruction`, `respond_to_approval`, and `get_codex_access_summary`.

1. Start the backend:

```bash
npm run dev:backend
```

2. Expose the backend with an HTTPS tunnel:

```bash
ngrok http 4317
```

3. Add the public tunnel URL to `.env` and restart the backend:

```bash
TWILIO_SMS_ENABLED=1
TWILIO_VOICE_ENABLED=1
CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL=https://your-tunnel.ngrok-free.app
TWILIO_CONVERSATION_RELAY_WS_URL=wss://your-tunnel.ngrok-free.app/twilio/conversation-relay
TWILIO_VALIDATE_SIGNATURES=1
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_MESSAGING_SERVICE_SID=your_twilio_messaging_service_sid
# or TWILIO_FROM_NUMBER=+15551234567
```

`TWILIO_ACCOUNT_SID` plus either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER` enables outbound progress milestones for SMS sessions. Without those optional values, SMS still works for inbound command/response and progress remains recorded in the session timeline.

4. Configure your Twilio phone number webhooks:

```text
Voice incoming call webhook: POST https://your-tunnel.ngrok-free.app/twilio/voice
Messaging inbound webhook: POST https://your-tunnel.ngrok-free.app/twilio/sms
Optional message status callback: POST https://your-tunnel.ngrok-free.app/twilio/message-status
```

5. Call or text the number.

Useful phrases:

```text
what is Codex doing?
what changed?
what files did it touch?
what commands did it run?
what approval is pending?
why does it need that?
approve it
deny it
tell Codex to summarize the workspace
what can Codex access right now?
```

Voice calls use Twilio ConversationRelay at `/twilio/conversation-relay`. Twilio requires a public `wss://` URL for real calls. `TWILIO_CONVERSATION_RELAY_WS_URL` must be configured explicitly; the backend will not derive or invent it. If Twilio voice is disabled, the webhook returns TwiML telling the caller voice is not enabled instead of exposing a raw HTTP error.

## Tests

```bash
npm test
npm run typecheck
```

## Notes

- This MVP treats approvals at the supervisor layer. Codex is instructed not to execute risky shell/network/install/delete/deploy/git-push actions until explicitly approved.
- Secrets are never exposed in the access summary. Only environment variable names are shown.
- The phone and SMS bridge never runs shell commands directly. It only sends messages through the supervisor intent router and approval firewall.
