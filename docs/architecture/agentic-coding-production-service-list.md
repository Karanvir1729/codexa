# Agentic Coding Production Microservices Service List

| Component | Runs On | Role |
|---|---|---|
| Developer Web App / React Client | User device | Workspace UI, session state, WebRTC setup, local event capture. |
| Microphone Input + WebRTC Client | User device | Captures audio and streams media to Daily/WebRTC. |
| Local VAD / Silence Detection | User device | Detects pauses, barge-in guidance steps, and turn boundaries before server round trips. |
| Local Audio Quality Checker | User device | Emits noise, clipping, and packet-quality signals. |
| Lightweight Local Model Runner | User device | Runs confusion/engagement and topic classifiers locally. |
| Local TTS Phrase Cache | User device | Plays known phrases if server TTS fails or times out. |
| Optional WebGPU LLM Fallback | User device | Degraded/offline fallback for simple assistant responses. |
| Client Event Emitter | User device | Sends local signals and heartbeat events to backend. |
| Traefik / TLS Ingress | Edge | Terminates TLS and routes HTTP/WebSocket traffic. |
| Daily / WebRTC Transport | Edge | Real-time media transport between browser and voice workers. |
| Voice Gateway Service | Edge | Replicated ingress for voice sessions and client events. |
| Session Router | Edge | Maps room/session IDs to Pipecat runtime workers. |
| Auth / Session Service | Edge | Validates session tokens and binds developer/session identity. |
| Rate Limiter | Edge | Redis-backed limits for sessions, events, and model calls. |
| Pipecat Voice Runtime Workers | Real-time backend | Low-latency voice frame pipeline, interruption handling, ASR/TTS integration. |
| ASR Router | Real-time backend | Routes streaming ASR to primary NVIDIA Riva or fallback ASR. |
| Coding Agent Orchestrator | Real-time backend | Coordinates live context, strategy, model calls, and response planning. |
| Live Context Builder | Real-time backend | Builds compact state from L1 cache, Redis cache, and recent events. |
| Inference Gateway | Real-time backend | Routes to fast open-weight model runtime such as vLLM/Triton. |
| TTS Router | Real-time backend | Routes streaming speech to primary TTS or fallback/cached phrases. |
| Redis Streams Event Bus | Event/data plane | Typed event backbone for transcript, alert, command, eval, and strategy events. |
| Redis Cache + L1 Caches | Event/data plane | Fast session context, RAG query cache, strategy scores, and hot transcript state. |
| Developer State Agent | Async worker | Updates task confidence, confusion, confidence, and active sub-skill state. |
| Failure Mode Detection Agent | Async worker | Tags failure patterns and emits failure_mode.detected alerts. |
| RAG Retrieval Agent | Async/near-real-time worker | Retrieves codebase knowledge, failure pattern, developer, cohort, eval, and strategy context. |
| Similar Developer Agent | Async worker | Finds cohort patterns and strategies that worked for similar learners. |
| Coding Strategy Agent | Async worker | Produces candidate coding actions and strategy updates. |
| SCIP Optimizer Service | Near-real-time worker | Solves constrained action selection under latency and learning constraints. |
| Eval Generation Agent | Async worker | Converts real failures into regression eval cases. |
| Auto-Improvement Agent | Async worker | Proposes, tests, promotes, or rolls back coding strategy changes. |
| Qdrant Vector DB | Data layer | Stores codebase knowledge, failure pattern, developer memory, cohort, eval, and strategy vectors. |
| Embedding Worker | Async worker/data layer | Generates embeddings and updates vector indexes. |
| KB Ingestion Worker | Async worker/data layer | Chunks and validates workspaces, evals, and strategy artifacts. |
| Postgres | Data layer | Strategy registry, developer/session tables, eval results, and version metadata. |
| S3 / MinIO | Data layer | Raw transcript/audio artifacts, eval snapshots, and workspace artifacts. |
| Failure Trace Store | Data layer | Stores traces linking failure, failure mode, strategy version, and eval provenance. |
| Evaluation Harness | Async worker | Runs scenario bank, simulated developers, regression runner, and eval judge. |
| Strategy Promotion Gate | Async worker | Promotes only tested strategies and rolls back regressions. |
| Docker Swarm Cluster | Deployment layer | Replicates stateless services and manages rolling updates. |
| OpenTelemetry / Prometheus / Grafana | Observability layer | Traces, metrics, latency alerts, queue lag, model fallback rate, eval regression alerts. |
