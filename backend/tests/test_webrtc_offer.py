from app.webrtc_sessions import is_known_webrtc_peer


class StubWebRTCHandler:
    def __init__(self):
        self._pcs_map = {"SmallWebRTCConnection#0-test": object()}


def test_known_webrtc_peer_allows_reconnect_detection():
    handler = StubWebRTCHandler()

    assert is_known_webrtc_peer(handler, "SmallWebRTCConnection#0-test") is True
    assert is_known_webrtc_peer(handler, "SmallWebRTCConnection#0-other") is False
    assert is_known_webrtc_peer(handler, None) is False
