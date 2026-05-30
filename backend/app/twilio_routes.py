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
    if settings.pipecat_cloud_ws_url and settings.pipecat_cloud_service_host:
        stream_url = settings.pipecat_cloud_ws_url
        service_param = (
            f'<Parameter name="_pipecatCloudServiceHost" '
            f'value="{escape(settings.pipecat_cloud_service_host)}" />'
        )
    else:
        stream_url = _to_ws_url(settings.public_base_url, "/twilio/media-stream")
        service_param = ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{escape(stream_url)}">
      {service_param}
      <Parameter name="agent_profile" value="default" />
    </Stream>
  </Connect>
</Response>"""

