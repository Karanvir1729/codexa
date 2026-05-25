# Agentic Coding Voice Agent Architecture

This folder now has two diagrams:

- `agentic-coding-hackathon-architecture.excalidraw`: the judge-facing diagram. It is intentionally clean and focused on realtime coding assistance plus eval-gated self-improvement.
- `agentic-coding-technical-appendix.excalidraw`: the implementation appendix with node-level worker pools, Redis stream shards, retry/DLQ, event contracts, data stores, and deployment options.

## Realtime Path

The red path is the low-latency voice path:

```text
Browser via Daily/WebRTC
or phone via Twilio
-> Daily/Twilio ingress
-> Pipecat-compatible voice service
-> streaming ASR
-> Coding Agent LLM
-> streaming TTS
-> developer
```

This path stays colocated. Do not split `WebRTC/Twilio/Daily/Pipecat -> ASR -> Coding Agent LLM -> TTS` across clouds unless latency tests prove it is acceptable. The live assistant reads only fast state from Redis: session context, developer learning state, and the active promoted coding strategy.

## GCP Prototype, AWS Target

The one-week prototype is GCP-first for speed:

- Cloud Run / Compute Engine containers for backend APIs, dashboard APIs, async workers, and voice services.
- Memorystore Redis or Upstash Redis for Redis Streams, hot context, and active strategy cache.
- Cloud SQL Postgres for strategy registry, session metadata, and eval results.
- Cloud Storage for replay traces, audio snippets, and eval artifacts.
- Artifact Registry plus Cloud Build or GitHub Actions for CI/CD.
- Cloud Logging, Cloud Monitoring, and Cloud Trace for observability.
- Secret Manager for API keys and service config.

The production target maps cleanly to AWS:

- Cloud Run -> ECS Fargate / App Runner
- Cloud SQL Postgres -> RDS / Aurora
- Memorystore Redis -> ElastiCache / MemoryDB
- Cloud Storage -> S3
- Cloud Logging/Monitoring/Trace -> CloudWatch + X-Ray + OpenTelemetry
- Secret Manager -> AWS Secrets Manager / Parameter Store
- Artifact Registry -> ECR

Async eval and replay workers can move across clouds because they do not block live coding assistance.

## Async Learning Path

The blue dashed path is the event/data plane. Pipecat and the assistant orchestrator emit typed events into Redis Streams:

- `transcript.final`
- `client_signal.detected`
- `developer_state.updated`
- `failure_mode.detected`
- `strategy.failed`
- `eval_case.generated`
- `strategy.promoted`
- `strategy.rollback`

Async learning agents consume these events through Redis consumer groups and publish results back. The agents coordinate through Redis Streams rather than direct service chaining.

## Eval-Gated Promotion

Agentic Coding improves through strategy and policy promotion, not live fine-tuning:

```text
Observed Failure
-> Failure Mode Classified
-> Candidate Coding Strategy
-> Replay Eval Generated
-> Tested Against Baseline
-> Promoted Strategy
-> Active Strategy Cache
-> Next Similar Developer Gets Better Explanation
```

If replay evals regress, the strategy is rejected or rolled back. Only promoted strategy versions are copied into the Redis Active Coding Strategy Cache used by the realtime assistant.

## Partner Mapping

| Partner | Architecture role | Visible proof |
| --- | --- | --- |
| Daily | Realtime browser voice infrastructure | Daily/WebRTC ingress, Pipecat-compatible orchestration, low-latency turn-taking |
| Twilio | phone-based coding assistance ingress | Phone sessions route into the same realtime assistant pipeline |
| Cekura | Automated eval and monitoring loop | Replay evals, baseline comparison, regression gate, rollback status |
| NVIDIA | Accelerated model runtime | Hosted NIM APIs first, NeMo Retriever for RAG, optional Riva ASR/TTS later |
| GCP | Prototype deployment substrate | Cloud Run, Memorystore/Upstash Redis, Cloud SQL, Cloud Storage, Cloud Logging/Monitoring |
| AWS | Production target | ECS/App Runner, ElastiCache/MemoryDB, RDS/Aurora, S3, CloudWatch/X-Ray/OTel |

## 90-Second Demo

1. Developer asks why a coding problem is not calculator bug.
2. Assistant answers quickly over voice using the active coding strategy.
3. Developer remains confused or interrupts; the system emits `failure_mode.detected` and `strategy.failed`.
4. Async agents retrieve similar failures and propose a better strategy, such as checking replacement/independence before formulas.
5. Eval worker replays the candidate strategy against baseline scenarios.
6. Promotion gate accepts the candidate only if learning metrics improve.
7. Dashboard shows transcript, failure mode, selected strategy, eval before/after, promoted version, and rollback state.
8. A second similar developer receives the improved explanation from the Active Coding Strategy Cache.

## Generated Artifacts

- Judge diagram: `agentic-coding-hackathon-architecture.excalidraw`
- Judge SVG: `screenshots/agentic-coding-hackathon-architecture.svg`
- Judge PNG: `screenshots/agentic-coding-hackathon-architecture.png`
- Technical appendix: `agentic-coding-technical-appendix.excalidraw`
- Technical appendix SVG: `screenshots/agentic-coding-technical-appendix.svg`
- Technical appendix PNG: `screenshots/agentic-coding-technical-appendix.png`
- Request/event appendix: `agentic-coding-request-event-contracts.md`
