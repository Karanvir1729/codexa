from app.webrtc_sessions import is_known_webrtc_peer
from app.main import is_small_webrtc_renegotiating


class StubWebRTCHandler:
    def __init__(self):
        self._pcs_map = {"SmallWebRTCConnection#0-test": object()}


def test_known_webrtc_peer_allows_reconnect_detection():
    handler = StubWebRTCHandler()

    assert is_known_webrtc_peer(handler, "SmallWebRTCConnection#0-test") is True
    assert is_known_webrtc_peer(handler, "SmallWebRTCConnection#0-other") is False
    assert is_known_webrtc_peer(handler, None) is False


def test_small_webrtc_renegotiation_state_is_detected():
    class Connection:
        _renegotiation_in_progress = True

    assert is_small_webrtc_renegotiating(Connection()) is True
    assert is_small_webrtc_renegotiating(object()) is False
