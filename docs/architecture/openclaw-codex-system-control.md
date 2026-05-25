# OpenClaw + Codex System-Control Plan

Tutor-Tron has two control paths:

1. **Realtime voice path:** Pipecat/Twilio/Daily owns audio transport, turn-taking, STT, LLM, and TTS. This path must stay low-latency and should not wait for heavy system-control work.
2. **System-control path:** Codex and OpenClaw handle repo/system actions when the user asks the voice agent to inspect, edit, test, operate apps, or report status.

## Why OpenClaw

OpenClaw is useful here because it is a local-first gateway for a personal assistant that can route messages, tools, sessions, nodes, and channels from one control plane. For Tutor-Tron, it gives us a cleaner way to grow from "phone call talks to Codex" into "voice agent can operate my whole laptop and development environment."

The repo now installs OpenClaw locally as a dev dependency and installs the official OpenClaw Codex plugin in the local OpenClaw plugin registry.

## Runtime Shape

```text
Browser / phone caller
  -> Pipecat realtime voice pipeline
  -> Tutor-Tron phone Codex bridge
  -> Codex control router
     -> Direct Codex CLI for repo-local work
     -> OpenClaw agent for broader system actions
  -> Codex / Computer Use / browser / app nodes
```

OpenClaw should be treated as a **system-control plane**, not as the realtime voice transport. Pipecat remains the voice runtime because it is built for streaming audio, barge-in, phone/WebRTC transport, and turn handling.

## No-Call Test Paths

Use these when you want confidence without dialing the Twilio number:

```bash
npm run phone:test:codex
```

This calls the OpenAI-compatible local endpoint:

```text
POST /api/phone/v1/chat/completions
```

It exercises the same Codex bridge used by the Pipecat phone bot, but without PSTN, Twilio Media Streams, ASR, or TTS.

Use this when you want to validate the Twilio/Pipecat edge without making a call:

```bash
npm run phone:test:stack
```

That checks:

- local Pipecat TwiML endpoint
- ngrok tunnel
- public TwiML endpoint
- Twilio number webhook configuration

The Test Dashboard also has a **No-call phone test** button that runs the same bridge smoke test from the browser.

## Codex Control Router

The browser app exposes a **Codex control plane** selector:

| Provider | Behavior |
| --- | --- |
| `codex` | Calls local `codex exec` directly. Best for fast repo-local edits and tests. |
| `openclaw` | Calls `openclaw agent --local --session-key ...` so OpenClaw can route to Codex/system tools. |
| `auto` | Uses OpenClaw if available and falls back to direct Codex if OpenClaw fails. |

The same provider can be selected for phone calls with:

```bash
PHONE_CODEX_CONTROL_PROVIDER=openclaw
```

Direct endpoint smoke test:

```bash
npm run openclaw:control:test
```

## OpenClaw Readiness

Run:

```bash
npm run openclaw:readiness
```

This checks:

- OpenClaw CLI is available
- official Codex plugin is loaded
- read-only OpenClaw doctor lint passes
- whether the gateway is currently running

Start the gateway only when you want to enable broader local system-control routing:

```bash
npm run openclaw:gateway
```

The gateway command runs in foreground dev mode on loopback. Do not expose it publicly until pairing, auth, and allowlists are configured.

## Permission Model

Tutor-Tron should distinguish three action levels:

| Level | Route | Example |
| --- | --- | --- |
| Conversational tutoring | Tutor LLM | "Explain derivatives." |
| Repo-local coding | Codex pilot | "Run the tests and fix the failing voice suite." |
| Whole-system operation | OpenClaw gateway + nodes | "Open the app, inspect the browser, and control my dev environment." |

Voice-triggered full-system actions should be logged and should require an explicit user request. That keeps the phone agent useful without silently giving every utterance full laptop control.

## Next Integration Step

The next real integration is a small adapter behind the existing Codex bridge:

```text
if user asks for broad system operation:
  call OpenClaw gateway / agent route
else:
  call Codex pilot directly
```

That adapter should keep a transcript of:

- original voice request
- cleaned speech intent
- selected route: tutor, Codex, or OpenClaw
- tool calls/actions performed
- spoken summary returned to the caller
