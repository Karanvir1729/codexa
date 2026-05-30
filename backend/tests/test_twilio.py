from app.config import Settings
from app.twilio_routes import (
    _to_ws_url,
    gather_twiml,
    inbound_twiml,
    no_input_twiml,
    should_use_media_stream,
    voice_turn_twiml,
)


def test_to_ws_url_maps_http_and_https_public_urls():
    assert _to_ws_url("http://localhost:8000", "/twilio/media-stream") == (
        "ws://localhost:8000/twilio/media-stream"
    )
    assert _to_ws_url("https://voice.example.com", "/twilio/media-stream") == (
        "wss://voice.example.com/twilio/media-stream"
    )


def test_inbound_twiml_uses_public_base_url_when_cloud_settings_absent():
    xml = inbound_twiml(
        Settings(public_base_url="https://voice.example.com", twilio_voice_mode="media_stream")
    )

    assert '<Stream url="wss://voice.example.com/twilio/media-stream">' in xml
    assert 'name="agent_profile" value="default"' in xml
    assert "_pipecatCloudServiceHost" not in xml


def test_inbound_twiml_uses_pipecat_cloud_settings_and_escapes_values():
    xml = inbound_twiml(
        Settings(
            pipecat_cloud_ws_url="wss://api.pipecat.example/ws/twilio?x=<bad>",
            pipecat_cloud_service_host="svc.example.com/<host>",
        )
    )

    assert 'url="wss://api.pipecat.example/ws/twilio?x=&lt;bad&gt;"' in xml
    assert 'name="_pipecatCloudServiceHost" value="svc.example.com/&lt;host&gt;"' in xml


def test_auto_twilio_mode_uses_gather_without_pipecat_runtime():
    settings = Settings(public_base_url="https://voice.example.com", voice_runtime="text")

    assert should_use_media_stream(settings) is False

    xml = inbound_twiml(settings, call_sid="CA123")

    assert "<Gather" in xml
    assert 'input="speech"' in xml
    assert "You are connected to the voice coding agent" in xml
    assert "conversation_id=twilio-call-CA123" in xml
    assert "/twilio/media-stream" not in xml


def test_auto_twilio_mode_keeps_media_stream_for_pipecat_runtime():
    settings = Settings(public_base_url="https://voice.example.com", voice_runtime="pipecat")

    assert should_use_media_stream(settings) is True
    assert "/twilio/media-stream" in inbound_twiml(settings)


def test_gather_twiml_uses_webhook_base_and_escapes_response():
    settings = Settings(
        public_base_url="http://localhost:8000",
        twilio_webhook_base_url="https://voice.example.com",
    )

    xml = voice_turn_twiml(settings, "A <great> answer", "twilio-call-1")

    assert 'action="https://voice.example.com/twilio/voice-turn?conversation_id=twilio-call-1"' in xml
    assert "A &lt;great&gt; answer" in xml


def test_gather_twiml_trims_long_agent_responses():
    settings = Settings(public_base_url="https://voice.example.com")

    xml = gather_twiml(settings, "hello")
    long_xml = voice_turn_twiml(settings, "word " * 400)

    assert "hello" in xml
    assert len(long_xml) < 1800


def test_no_input_twiml_hangs_up_after_empty_turn_limit():
    settings = Settings(
        _env_file=None,
        public_base_url="https://voice.example.com",
        twilio_gather_max_empty_turns=2,
    )

    retry_xml = no_input_twiml(settings, "twilio-call-1", no_input_count=1)
    final_xml = no_input_twiml(settings, "twilio-call-1", no_input_count=2)

    assert "no_input_count=2" in retry_xml
    assert "<Redirect" in retry_xml
    assert "<Hangup />" in final_xml
    assert "<Redirect" not in final_xml


def test_twilio_number_alias_supports_existing_env_name():
    settings = Settings(_env_file=None, twilio_phone_number="+15551234567")

    assert settings.twilio_effective_from_number == "+15551234567"
