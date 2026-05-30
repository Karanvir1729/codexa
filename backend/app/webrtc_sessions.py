from __future__ import annotations

from typing import Any


def is_known_webrtc_peer(handler: Any, pc_id: str | None) -> bool:
    if not pc_id:
        return False
    pcs_map = getattr(handler, "_pcs_map", {})
    return isinstance(pcs_map, dict) and pc_id in pcs_map
