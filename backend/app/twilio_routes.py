from __future__ import annotations

from html import escape
from urllib.parse import urlparse

from .config import Settings


def _to_ws_url(public_base_url: str, path: str) -> str:
    parsed = urlparse(public_base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    host = parsed.netloc or parsed.path
    return f"{scheme}://{host}{path}"


def inbound_twiml(settings: Settings) -> str:
    stream_url = _to_ws_url(settings.public_base_url, "/twilio/media-stream")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{escape(stream_url)}">
      <Parameter name="agent_profile" value="default" />
    </Stream>
  </Connect>
</Response>"""
