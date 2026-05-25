from app.config import Settings
from app.twilio_routes import inbound_twiml


def test_local_twiml_points_to_self_hosted_websocket():
    settings = Settings(public_base_url="https://voice.example.com")

    twiml = inbound_twiml(settings)

    assert '<Connect>' in twiml
    assert 'wss://voice.example.com/twilio/media-stream' in twiml


def test_pipecat_cloud_twiml_uses_service_host():
    settings = Settings(
        pipecat_cloud_ws_url="wss://api.pipecat.daily.co/ws/twilio",
        pipecat_cloud_service_host="agent.org",
    )

    twiml = inbound_twiml(settings)

    assert 'wss://api.pipecat.daily.co/ws/twilio' in twiml
    assert '_pipecatCloudServiceHost' in twiml
    assert 'agent.org' in twiml

