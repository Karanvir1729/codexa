# AWS GPU Quota Appeal Draft

Use this when reopening the rejected EC2 Service Quotas case for `Running On-Demand G and VT instances` in `us-east-2`.
The current AWS case reply submitted on May 24, 2026 used the more specific text below.

```text
Hello AWS Support,

Please re-assess this quota request with a much smaller and more specific scope. The current case shows All P instances / New Limit = 96, but that is not the minimum capacity we need for the hackathon prototype. If this case cannot be converted, please use this correspondence as the detailed business/use-case justification for a new minimum request:

Requested quota:
- Region: US East (Ohio) / us-east-2
- Service: EC2 Instances
- Quota needed: Running On-Demand G and VT instances
- Desired value: 4 vCPU
- Target instance: one g5.xlarge only
- Expected usage: short development and benchmark windows for a hackathon voice-agent prototype

Use case:
We are building a real-time voice agent for a hackathon. The system uses Twilio telephony, a self-hosted Pipecat voice pipeline, and an OpenAI-compatible local inference endpoint. We need one NVIDIA GPU instance to test a vLLM-hosted open-weight model with realistic voice-agent latency and reliability. The goal is to validate end-to-end call latency, streaming turn-taking, transcript capture, automated evals, and a feedback loop that improves prompt/model behavior over time.

Why GPU is required:
CPU-only inference is too slow for real-time telephony and does not let us validate the actual production architecture. A single g5.xlarge is sufficient for the first AWS test because we can start with a smaller NVIDIA/Qwen/Nemotron-compatible open-weight model and later swap models through the same OpenAI-compatible API. We are not asking for production scale capacity.

Cost and risk controls:
- Minimum request is only 4 vCPU, enough for one g5.xlarge.
- The CloudFormation stack auto-stops the instance after 4 hours.
- The stack is tagged Project=voice-agent-feedback-engine.
- The app has a local model-call cost guard and can run in local Ollama mode when GPU is unavailable.
- This is for a bounded hackathon prototype, not large-scale batch processing or resale.

Please approve the minimum 4 vCPU G/VT quota required for one g5.xlarge, or advise the exact quota category/request format you want us to submit for this limited use case.

Thank you.
```
