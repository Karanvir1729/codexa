# Tutor-Tron Request and Event Contracts

This is the implementation appendix for the main architecture diagram. The main judge diagram intentionally keeps these details out of the visual flow.

## HTTP Requests

### `POST /v1/sessions`

Creates a browser or phone tutoring session and assigns a realtime voice node.

```json
{
  "student_id": "student_123",
  "topic": "probability",
  "client_caps": {
    "webrtc": true,
    "twilio_phone": false,
    "local_vad": true
  },
  "trace_id": "trace_abc",
  "region_hint": "us-east"
}
```

Response:

```json
{
  "session_id": "session_123",
  "webrtc_token": "daily_or_transport_token",
  "voice_node": "voice-node-a",
  "ingress": "daily_webrtc"
}
```

### `POST /internal/turns/plan`

Plans the next low-latency tutor action. This reads only fast session state and the active promoted teaching strategy.

```json
{
  "session_id": "session_123",
  "transcript_final": "I still do not get why this is not binomial.",
  "local_signals": {
    "barge_in": false,
    "silence_ms": 420,
    "audio_quality": "good"
  },
  "active_strategy_id": "strategy_replacement_first_v3",
  "response_id": "resp_456"
}
```

Response:

```json
{
  "action": "ask_diagnostic_question",
  "cancel_previous": true,
  "tts_text": "Before the formula, check one thing: are we putting the item back after each draw?"
}
```

### `POST /internal/strategies/promote`

Promotes a tested teaching strategy after replay evals and regression checks pass.

```json
{
  "candidate_strategy_id": "strategy_replacement_first_v4",
  "eval_run_id": "eval_run_789",
  "baseline_score": 0.64,
  "candidate_score": 0.83,
  "rollback_policy": "restore_previous_on_regression"
}
```

Response:

```json
{
  "promoted_strategy_id": "strategy_replacement_first_v4",
  "registry": "cloud_sql_postgres",
  "active_cache_updated": true
}
```

## Redis Stream Events

All async services write typed events to Redis Streams on GCP Memorystore during the prototype. The AWS production target is ElastiCache Redis or MemoryDB.

### Generic envelope

```json
{
  "event_id": "evt_123",
  "type": "pitfall.detected",
  "session_id": "session_123",
  "student_id": "student_123",
  "source": "pitfall-agent",
  "trace_id": "trace_abc",
  "schema_version": "2026-05-21",
  "idempotency_key": "session_123:pitfall:binomial_001",
  "payload": {}
}
```

### Core event types

- `transcript.final`
- `client_signal.detected`
- `student_state.updated`
- `pitfall.detected`
- `strategy.failed`
- `eval_case.generated`
- `eval_run.completed`
- `strategy.promoted`
- `strategy.rollback`

## Promotion Contract

Only promoted strategy versions affect live tutoring.

```text
Observed failure
-> Pitfall classified
-> Candidate strategy proposed
-> Replay eval generated
-> Tested against baseline
-> Promotion gate passes
-> Cloud SQL strategy version updated
-> Memorystore active strategy cache updated
-> Next similar session uses improved strategy
```

If evals regress:

```text
Tested against baseline
-> Regression detected
-> Candidate rejected
-> Active strategy cache remains unchanged
```
