#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def public_url(path: str) -> str:
    explicit = env("TWILIO_VOICE_WEBHOOK_URL") if path == "/twilio/inbound" else ""
    if explicit:
        return explicit
    base = env("TWILIO_WEBHOOK_BASE_URL") or env("PUBLIC_BASE_URL")
    if not base:
        raise SystemExit("Set TWILIO_VOICE_WEBHOOK_URL or TWILIO_WEBHOOK_BASE_URL.")
    return f"{base.rstrip('/')}{path}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure Twilio Voice webhook for this app.")
    parser.add_argument("--phone-number-sid", default="", help="Override TWILIO_PHONE_NUMBER_SID.")
    parser.add_argument("--voice-url", default="", help="Override TWILIO_VOICE_WEBHOOK_URL.")
    parser.add_argument("--status-callback-url", default="", help="Override TWILIO_STATUS_CALLBACK_URL.")
    parser.add_argument("--dry-run", action="store_true", help="Print the planned update only.")
    args = parser.parse_args()

    load_env_file(REPO_ROOT / ".env")
    load_env_file(REPO_ROOT / ".env.local")

    account_sid = env("TWILIO_ACCOUNT_SID")
    auth_token = env("TWILIO_AUTH_TOKEN")
    phone_number_sid = args.phone_number_sid or env("TWILIO_PHONE_NUMBER_SID")
    voice_url = args.voice_url or public_url("/twilio/inbound")
    status_callback_url = (
        args.status_callback_url
        or env("TWILIO_STATUS_CALLBACK_URL")
        or public_url("/twilio/status")
    )

    missing = [
        name
        for name, value in [
            ("TWILIO_ACCOUNT_SID", account_sid),
            ("TWILIO_AUTH_TOKEN", auth_token),
            ("TWILIO_PHONE_NUMBER_SID", phone_number_sid),
        ]
        if not value
    ]
    if missing:
        raise SystemExit(f"Missing required Twilio config: {', '.join(missing)}")

    print(f"Voice webhook: {voice_url}")
    print(f"Status callback: {status_callback_url}")
    print(f"Phone number SID: {phone_number_sid}")
    if args.dry_run:
        return 0

    from twilio.rest import Client

    client = Client(account_sid, auth_token)
    updated = client.incoming_phone_numbers(phone_number_sid).update(
        voice_url=voice_url,
        voice_method="POST",
        status_callback=status_callback_url,
        status_callback_method="POST",
    )
    print(f"Updated Twilio number: {updated.phone_number}")
    print(f"Configured voice_url: {updated.voice_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
