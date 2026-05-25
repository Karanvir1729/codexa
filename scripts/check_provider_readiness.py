#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
GPU_G_QUOTA_CODE = "L-DB2E81BA"
GPU_P_QUOTA_CODE = "L-417A185B"


@dataclass
class Check:
    name: str
    status: str
    detail: str
    remediation: str = ""


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def env_value(key: str, file_env: dict[str, str]) -> str:
    return os.environ.get(key, file_env.get(key, ""))


def run_aws(args: list[str], region: str | None = None) -> tuple[int, str, str]:
    command = ["aws", *args]
    if region and "--region" not in args:
        command.extend(["--region", region])
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()


def aws_json(args: list[str], region: str | None = None) -> tuple[dict[str, Any] | list[Any] | None, str]:
    code, stdout, stderr = run_aws([*args, "--output", "json"], region)
    if code != 0:
        return None, stderr or stdout
    try:
        return json.loads(stdout), ""
    except json.JSONDecodeError as exc:
        return None, f"Invalid AWS JSON output: {exc}"


def http_json(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 20,
) -> tuple[int, dict[str, Any] | None, str]:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode()
            parsed = json.loads(body) if body else {}
            return response.status, parsed, ""
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        return exc.code, None, body or str(exc)
    except Exception as exc:
        return 0, None, str(exc)


def check_aws(region: str) -> list[Check]:
    checks: list[Check] = []
    identity, error = aws_json(["sts", "get-caller-identity"])
    if not identity:
        checks.append(
            Check(
                "aws_identity",
                "blocked",
                error,
                "Refresh local AWS credentials or sign in through AWS SSO/CloudShell.",
            )
        )
        return checks

    account = str(identity.get("Account", "unknown"))
    checks.append(Check("aws_identity", "ready", f"Authenticated to AWS account {account}."))

    quotas, error = aws_json(["service-quotas", "get-service-quota", "--service-code", "ec2", "--quota-code", GPU_G_QUOTA_CODE], region)
    if not quotas:
        checks.append(Check("aws_g_gpu_quota", "blocked", error, "Check EC2 Service Quotas manually."))
    else:
        value = float(quotas["Quota"]["Value"])
        status = "ready" if value >= 4 else "blocked"
        checks.append(
            Check(
                "aws_g_gpu_quota",
                status,
                f"Running On-Demand G and VT quota is {value:g} vCPU; g5.xlarge needs 4.",
                "Appeal quota rejection or use hosted NVIDIA NIM until quota is approved." if status == "blocked" else "",
            )
        )

    history, _error = aws_json(
        [
            "service-quotas",
            "list-requested-service-quota-change-history-by-quota",
            "--service-code",
            "ec2",
            "--quota-code",
            GPU_G_QUOTA_CODE,
        ],
        region,
    )
    if isinstance(history, dict) and history.get("RequestedQuotas"):
        latest = history["RequestedQuotas"][0]
        checks.append(
            Check(
                "aws_g_gpu_quota_request",
                str(latest.get("Status", "unknown")).lower(),
                f"Latest request {latest.get('Id', 'unknown')} desired {latest.get('DesiredValue', 'unknown')} vCPU.",
            )
        )

    p_quota, _error = aws_json(["service-quotas", "get-service-quota", "--service-code", "ec2", "--quota-code", GPU_P_QUOTA_CODE], region)
    if isinstance(p_quota, dict):
        checks.append(
            Check(
                "aws_p_gpu_quota",
                "info",
                f"Running On-Demand P quota is {float(p_quota['Quota']['Value']):g} vCPU.",
            )
        )
    return checks


def check_nvidia(file_env: dict[str, str], live: bool) -> Check:
    api_key = env_value("NVIDIA_API_KEY", file_env)
    base_url = env_value("NVIDIA_BASE_URL", file_env) or "https://integrate.api.nvidia.com/v1"
    model = env_value("NVIDIA_MODEL", file_env) or "nvidia/llama-3.3-nemotron-super-49b-v1.5"
    if not api_key:
        return Check(
            "nvidia_nim",
            "blocked",
            f"Configured model target is {model}, but NVIDIA_API_KEY is not set.",
            "Create an NVIDIA API key from build.nvidia.com and add it to .env.",
        )
    if not live:
        return Check("nvidia_nim", "configured", f"NVIDIA_API_KEY is present for {model}. Run with --live to test a real call.")

    status, _data, error = http_json(
        f"{base_url.rstrip('/')}/chat/completions",
        method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        payload={
            "model": model,
            "messages": [
                {"role": "system", "content": "/no_think\nAnswer in one short sentence."},
                {"role": "user", "content": "Say ready."},
            ],
            "temperature": 0,
            "max_tokens": 16,
            "stream": False,
        },
    )
    if 200 <= status < 300:
        return Check("nvidia_nim", "ready", f"Live NVIDIA NIM chat call succeeded for {model}.")
    return Check("nvidia_nim", "blocked", f"Live call failed with HTTP {status}: {error[:240]}", "Verify NVIDIA_API_KEY, model access, and trial credits.")


def check_ollama(file_env: dict[str, str], live: bool) -> Check:
    base_url = env_value("OLLAMA_BASE_URL", file_env) or "http://localhost:11434/v1"
    model = env_value("OLLAMA_MODEL", file_env) or "qwen2.5:0.5b"
    tags_url = f"{base_url.rstrip('/').removesuffix('/v1')}/api/tags"
    status, data, error = http_json(tags_url, timeout=5)
    if status != 200 or not data:
        return Check(
            "ollama",
            "blocked",
            f"Ollama is not reachable at {tags_url}: {error or status}",
            "Run ./scripts/setup_ollama_local.sh.",
        )
    models = {item.get("name") for item in data.get("models", [])}
    if model not in models:
        return Check(
            "ollama",
            "blocked",
            f"Ollama is running, but {model} is not pulled.",
            f"Run: OLLAMA_MODEL={model} ./scripts/setup_ollama_local.sh",
        )
    if not live:
        return Check("ollama", "ready", f"Ollama is running with local model {model}.")

    status, _data, error = http_json(
        f"{base_url.rstrip('/')}/chat/completions",
        method="POST",
        headers={"Authorization": "Bearer ollama", "Content-Type": "application/json"},
        payload={
            "model": model,
            "messages": [{"role": "user", "content": "Reply with ready."}],
            "temperature": 0,
            "max_tokens": 8,
            "stream": False,
        },
        timeout=60,
    )
    if 200 <= status < 300:
        return Check("ollama", "ready", f"Live Ollama chat call succeeded for {model}.")
    return Check("ollama", "blocked", f"Ollama live call failed with HTTP {status}: {error[:240]}", "Re-pull the model or restart Ollama.")


def check_twilio(file_env: dict[str, str], live: bool) -> Check:
    sid = env_value("TWILIO_ACCOUNT_SID", file_env)
    token = env_value("TWILIO_AUTH_TOKEN", file_env)
    number = env_value("TWILIO_FROM_NUMBER", file_env)
    if not sid or not token or not number:
        return Check(
            "twilio",
            "blocked",
            "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are required.",
            "Add Twilio credentials to .env, then configure the phone webhook to /twilio/inbound.",
        )
    if not live:
        return Check("twilio", "configured", f"Twilio credentials are present for number {number}. Run with --live to validate the account.")

    auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
    status, _data, error = http_json(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}.json",
        headers={"Authorization": f"Basic {auth}"},
    )
    if 200 <= status < 300:
        return Check("twilio", "ready", f"Twilio account is reachable; configured number is {number}.")
    return Check("twilio", "blocked", f"Twilio validation failed with HTTP {status}: {error[:240]}", "Verify the Account SID/Auth Token pair.")


def check_pipecat(file_env: dict[str, str]) -> Check:
    cloud_ws = env_value("PIPECAT_CLOUD_WS_URL", file_env)
    cloud_host = env_value("PIPECAT_CLOUD_SERVICE_HOST", file_env)
    voice_runtime = env_value("VOICE_RUNTIME", file_env) or "text"
    deepgram = env_value("DEEPGRAM_API_KEY", file_env)
    cartesia = env_value("CARTESIA_API_KEY", file_env)
    local_tts_provider = env_value("LOCAL_TTS_PROVIDER", file_env) or "auto"
    fish_base_url = env_value("FISH_SPEECH_BASE_URL", file_env) or "http://127.0.0.1:8080"
    if cloud_ws and cloud_host:
        return Check("pipecat", "ready", "Pipecat Cloud WebSocket route is configured.")
    if voice_runtime == "local_pipecat":
        required_modules = {
            "pipecat": "pipecat-ai",
            "aiortc": "pipecat-ai[webrtc]",
            "av": "pipecat-ai[webrtc]",
            "cv2": "opencv-python from pipecat-ai[webrtc]",
            "pyaudio": "pipecat-ai[local] plus Homebrew portaudio on macOS",
            "mlx_whisper": "pipecat-ai[mlx-whisper]",
            "kokoro_onnx": "pipecat-ai[kokoro]",
            "ormsgpack": "Fish Speech HTTP msgpack client",
            "onnxruntime": "pipecat-ai base Silero VAD dependency",
        }
        missing = [name for name in required_modules if importlib.util.find_spec(name) is None]
        if missing:
            details = ", ".join(f"{name} ({required_modules[name]})" for name in missing)
            return Check(
                "pipecat",
                "blocked",
                f"Local Pipecat mode is selected, but missing modules: {details}.",
                'Run: brew install portaudio && .venv/bin/python -m pip install -e "backend[voice]".',
            )
        if local_tts_provider == "fish_speech":
            status, data, error = http_json(f"{fish_base_url.rstrip('/')}/v1/health", timeout=5)
            if status == 200 and data:
                return Check(
                    "pipecat",
                    "ready",
                    "Local Pipecat runtime is installed and Fish Speech TTS server is healthy.",
                )
            return Check(
                "pipecat",
                "blocked",
                f"LOCAL_TTS_PROVIDER=fish_speech, but Fish Speech health failed: {error or status}",
                "Start Fish Speech server on FISH_SPEECH_BASE_URL, or set LOCAL_TTS_PROVIDER=auto/kokoro.",
            )
        if local_tts_provider == "auto":
            status, data, _error = http_json(f"{fish_base_url.rstrip('/')}/v1/health", timeout=2)
            fish_detail = (
                "Fish Speech TTS server is healthy and will be used."
                if status == 200 and data
                else "Fish Speech TTS server is not running; auto mode will use Kokoro."
            )
        else:
            fish_detail = "Kokoro TTS is forced by LOCAL_TTS_PROVIDER=kokoro."
        return Check(
            "pipecat",
            "ready",
            "Local Pipecat voice runtime is installed with PyAudio, MLX Whisper, Kokoro, "
            f"Fish Speech client support, and Silero VAD. {fish_detail}",
        )
    if voice_runtime == "pipecat" and deepgram and cartesia:
        return Check("pipecat", "ready", "Self-hosted Pipecat runtime has STT and TTS keys configured.")
    if voice_runtime == "pipecat":
        return Check(
            "pipecat",
            "blocked",
            "VOICE_RUNTIME=pipecat is selected for Twilio media streams, but Deepgram/Cartesia keys are missing.",
            "Set DEEPGRAM_API_KEY and CARTESIA_API_KEY, or use VOICE_RUNTIME=local_pipecat for local open-source voice testing.",
        )
    return Check(
        "pipecat",
        "info",
        "Pipecat is not selected for the current runtime.",
        "Set VOICE_RUNTIME=local_pipecat for local open-source voice, or configure Twilio/Pipecat provider mode later.",
    )


def check_backend() -> Check:
    status, data, error = http_json("http://127.0.0.1:8000/health", timeout=5)
    if status == 200 and data:
        return Check("local_backend", "ready", f"Backend health is ok with provider {data.get('llm_provider')} and model {data.get('model')}.")
    return Check("local_backend", "blocked", f"Backend health check failed: {error or status}", "Start the backend with ./scripts/run_backend.sh.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check provider readiness for the voice-agent system.")
    parser.add_argument("--env-file", default=".env", help="Path to environment file. Defaults to .env.")
    parser.add_argument("--live", action="store_true", help="Make live provider API calls where credentials are present.")
    parser.add_argument("--json", action="store_true", help="Emit JSON only.")
    args = parser.parse_args()

    file_env = load_env(REPO_ROOT / args.env_file)
    region = env_value("AWS_REGION", file_env) or env_value("AWS_DEFAULT_REGION", file_env) or "us-east-2"

    checks = [
        *check_aws(region),
        check_ollama(file_env, args.live),
        check_nvidia(file_env, args.live),
        check_twilio(file_env, args.live),
        check_pipecat(file_env),
        check_backend(),
    ]

    payload = {"region": region, "live": args.live, "checks": [asdict(check) for check in checks]}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"Provider readiness region={region} live={args.live}")
        for check in checks:
            print(f"[{check.status.upper()}] {check.name}: {check.detail}")
            if check.remediation:
                print(f"  -> {check.remediation}")

    blocking = {check.status for check in checks if check.status == "blocked"}
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
