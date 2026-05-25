# Agentic Coding AWS Architecture Service List

| Component | Runs on | Purpose |
|---|---|---|
| React web app | User device/browser | Workspace UI, WebRTC setup, local event capture. |
| WebGPU local models | User device/browser | Confusion/engagement classifier, topic classifier, optional local LLM fallback. |
| Local TTS cache | User device/browser | Plays cached phrases if server TTS fails. |
| Route 53 latency routing | AWS edge | Routes users to the closest healthy region/edge. |
| AWS Global Accelerator + NLB | AWS edge | Anycast ingress and stable low-latency network entrypoint. |
| EC2 Voice Gateway | AWS edge/backend | Replicated session gateway for WebRTC/events. |
| EC2 Pipecat ASG | Real-time backend | Voice pipeline workers in private subnets across AZs. |
| EC2 G5/G6 NVIDIA Riva ASR | Real-time backend model tier | GPU streaming ASR primary. |
| EC2 G5/G6 vLLM assistant model | Real-time backend model tier | Fast open-weight reasoning model. |
| EC2 TTS Router | Real-time backend | Routes primary TTS, fallback TTS, and cached phrase playback. |
| ElastiCache Redis Cluster | Cache/event plane | Hot context cache plus Redis Streams for alerts/commands/events. |
| Amazon Keyspaces / Cassandra ring | Distributed storage | RF=3 cohort/developer/strategy memory with local quorum style reliability. |
| Qdrant shards | Distributed vector layer | Codebase Knowledge, failure pattern, developer memory, cohort, eval, and strategy vectors. |
| Aurora Postgres | Durable data layer | Transactional registry, sessions, eval result tables. |
| S3 / MinIO | Durable object storage | Raw audio, transcripts, eval snapshots, artifacts. |
| Async worker ASG | Async worker layer | Developer state, failure mode, RAG, similar-developer, SCIP, eval, and strategy promotion workers. |
| EC2 GPU eval judge | Async model tier | Heavy judge/model synthesis off critical path. |
| CloudWatch / Prometheus / Grafana | Observability | Latency, queue lag, fallback rate, eval regression alerts. |
