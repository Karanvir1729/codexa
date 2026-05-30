from __future__ import annotations

from html import escape
from urllib.parse import urlencode, urlparse

from .config import Settings


TWILIO_CONVERSATION_PREFIX = "twilio-call-"


def _to_ws_url(public_base_url: str, path: str) -> str:
    parsed = urlparse(public_base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    host = parsed.netloc or parsed.path
    return f"{scheme}://{host}{path}"


def _to_http_url(public_base_url: str, path: str, query: dict[str, str] | None = None) -> str:
    parsed = urlparse(public_base_url)
    scheme = parsed.scheme or "http"
    host = parsed.netloc or parsed.path
    suffix = f"?{urlencode(query)}" if query else ""
    return f"{scheme}://{host}{path}{suffix}"


def twilio_conversation_id(call_sid: str | None) -> str | None:
    if not call_sid:
        return None
    return f"{TWILIO_CONVERSATION_PREFIX}{call_sid}"


def should_use_media_stream(settings: Settings) -> bool:
    if settings.twilio_voice_mode == "media_stream":
        return True
    if settings.twilio_voice_mode == "gather":
        return False
    return bool(
        (settings.pipecat_cloud_ws_url and settings.pipecat_cloud_service_host)
        or settings.voice_runtime == "pipecat"
    )


def media_stream_twiml(settings: Settings) -> str:
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


def _say(text: str, settings: Settings) -> str:
    return (
        f'<Say voice="{escape(settings.twilio_say_voice)}" '
        f'language="{escape(settings.twilio_gather_language)}">{escape(text)}</Say>'
    )


def _voice_turn_query(conversation_id: str | None, no_input_count: int = 0) -> dict[str, str] | None:
    query: dict[str, str] = {}
    if conversation_id:
        query["conversation_id"] = conversation_id
    if no_input_count > 0:
        query["no_input_count"] = str(no_input_count)
    return query or None


def gather_twiml(
    settings: Settings,
    prompt: str,
    conversation_id: str | None = None,
    no_input_count: int = 0,
) -> str:
    action_url = _to_http_url(
        settings.twilio_effective_public_base_url,
        "/twilio/voice-turn",
        _voice_turn_query(conversation_id, no_input_count),
    )
    empty_redirect_url = _to_http_url(
        settings.twilio_effective_public_base_url,
        "/twilio/voice-turn",
        _voice_turn_query(conversation_id, no_input_count + 1),
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="{escape(action_url)}" method="POST" language="{escape(settings.twilio_gather_language)}" timeout="{settings.twilio_gather_timeout}" speechTimeout="{escape(settings.twilio_gather_speech_timeout)}">
    {_say(prompt, settings)}
  </Gather>
  {_say("I did not catch that. Please say that again.", settings)}
  <Redirect method="POST">{escape(empty_redirect_url)}</Redirect>
</Response>"""


def voice_turn_twiml(settings: Settings, response_text: str, conversation_id: str | None = None) -> str:
    return gather_twiml(settings, _trim_for_twilio_say(response_text), conversation_id)


def no_input_twiml(
    settings: Settings,
    conversation_id: str | None = None,
    no_input_count: int = 0,
) -> str:
    if no_input_count >= settings.twilio_gather_max_empty_turns:
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  {_say("I still did not hear anything, so I will end the call. Please call back when you are ready.", settings)}
  <Hangup />
</Response>"""
    return gather_twiml(
        settings,
        "I did not hear anything. Please say that again.",
        conversation_id,
        no_input_count,
    )


def error_twiml(settings: Settings) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  {_say("I am having trouble reaching the voice agent right now. Please try again soon.", settings)}
  <Hangup />
</Response>"""


def inbound_twiml(settings: Settings, call_sid: str | None = None) -> str:
    if should_use_media_stream(settings):
        return media_stream_twiml(settings)
    return gather_twiml(
        settings,
        "You are connected to the voice coding agent. How can I help?",
        twilio_conversation_id(call_sid),
    )


def _trim_for_twilio_say(text: str, limit: int = 1200) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 1].rstrip()}."
