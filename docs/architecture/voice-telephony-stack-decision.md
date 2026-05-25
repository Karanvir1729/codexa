# Voice + Telephony Stack Decision

## Decision

Tutor-Tron should not hand-roll Twilio media streaming, barge-in, packet serialization, or transport orchestration.

Use **Pipecat** as the realtime voice-agent framework:

- Browser / desktop voice: Pipecat client + Daily/WebRTC transport.
- Phone voice: Twilio Programmable Voice + Media Streams + Pipecat `FastAPIWebsocketTransport` + `TwilioFrameSerializer`.
- Production hosting: Pipecat Cloud/Daily first, self-hosted Pipecat on GCP/AWS later if needed.
- Tutor-Tron custom layer: Codex pilot tools, student memory, strategy/eval loop, dashboard, and tutoring policies.

## Why

Pipecat already solves the transport and pipeline parts we need:

- Open-source Python framework for realtime voice and multimodal AI agents.
- Pipeline model: `transport.input() -> STT -> user aggregation -> LLM -> TTS -> transport.output()`.
- Built-in transport abstraction for Daily, LiveKit, SmallWebRTC, FastAPI WebSocket, and telephony.
- Built-in telephony serializers for Twilio, Telnyx, Plivo, Exotel, and Vonage.
- Official Twilio examples using Twilio Media Streams over WebSocket.
- Service plugin surface for STT, LLM, TTS, NVIDIA, Ollama, Fish, OpenAI, Deepgram, Cartesia, etc.

That means we should not build our own:

- Twilio WebSocket parser.
- 8 kHz telephony audio packet handling.
- Twilio media stream serializer.
- Low-level audio input/output frame loop.
- Browser WebRTC transport.
- Barge-in plumbing at the media-transport layer.

## Target Architecture

```text
Browser / Desktop
  -> Pipecat client SDK
  -> Daily/WebRTC transport
  -> Pipecat bot pipeline
  -> Tutor-Tron Codex pilot + memory/eval services

Phone Call
  -> Twilio number
  -> TwiML <Connect><Stream>
  -> Pipecat Twilio WebSocket endpoint
  -> TwilioFrameSerializer
  -> Pipecat bot pipeline
  -> Tutor-Tron Codex pilot + memory/eval services
```

## Implementation Boundary

Pipecat owns:

- realtime audio transport
- transport lifecycle
- media stream serialization
- STT/LLM/TTS pipeline orchestration
- turn aggregation and VAD integration
- phone/web transport switching

Tutor-Tron owns:

- system prompt and tutoring behavior
- Codex pilot integration
- student profile and memory
- pitfall/strategy/eval loop
- dashboard and test reporting
- hackathon demo scripts

## Free-Tier Setup Direction

For a low-cost prototype:

1. Create a Twilio trial account and trial voice number.
2. Expose local Pipecat bot with ngrok during development.
3. Configure Twilio TwiML Bin:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://YOUR_NGROK_DOMAIN/ws" />
  </Connect>
</Response>
```

4. Run the Pipecat Twilio bot locally.
5. Call the trial number from a verified caller ID.

For production/demo polish:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://api.pipecat.daily.co/ws/twilio">
      <Parameter name="_pipecatCloudServiceHost" value="AGENT_NAME.ORGANIZATION_NAME"/>
    </Stream>
  </Connect>
</Response>
```

## Env Variables

```bash
TELEPHONY_STACK=pipecat
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WEBHOOK_BASE_URL=
PIPECAT_TRANSPORT=twilio
PIPECAT_PUBLIC_WS_URL=wss://YOUR_NGROK_DOMAIN/ws
DAILY_API_KEY=
```

## Sources

- Pipecat introduction: https://docs.pipecat.ai/overview/introduction
- Pipecat transports: https://docs.pipecat.ai/pipecat/learn/transports
- Pipecat Twilio WebSocket transport: https://docs.pipecat.ai/pipecat-cloud/guides/telephony/twilio-websocket
- Pipecat supported services: https://docs.pipecat.ai/server/services/supported-services
- Pipecat examples repository: https://github.com/pipecat-ai/pipecat-examples/tree/main/twilio-chatbot
- LiveKit voice agents alternative: https://livekit.com/voice-agents
