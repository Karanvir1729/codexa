from app.config import Settings
from app.twilio_routes import _to_ws_url, inbound_twiml


def test_to_ws_url_maps_http_and_https_public_urls():
    assert _to_ws_url("http://localhost:8000", "/twilio/media-stream") == (
        "ws://localhost:8000/twilio/media-stream"
    )
    assert _to_ws_url("https://voice.example.com", "/twilio/media-stream") == (
        "wss://voice.example.com/twilio/media-stream"
    )


def test_inbound_twiml_uses_public_base_url_when_cloud_settings_absent():
    xml = inbound_twiml(Settings(public_base_url="https://voice.example.com"))

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
