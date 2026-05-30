from __future__ import annotations

import re
from typing import Literal


VoiceSpeedIntent = Literal["slower", "very_slow", "normal", "faster", "very_fast"]
VoiceEmotionCode = Literal["N", "F", "C", "P", "S", "E"]
VoiceTone = Literal[
    "neutral",
    "friendly",
    "careful",
    "confident",
    "sympathetic",
    "energetic",
    "calm",
    "spooky",
    "arrogant",
    "condescending",
    "whisper",
]


VOICE_EMOTION_CODES: dict[VoiceEmotionCode, str] = {
    "N": "neutral",
    "F": "friendly",
    "C": "careful",
    "P": "confident",
    "S": "sympathetic",
    "E": "energetic",
}

VOICE_EMOTION_SYSTEM_PROMPT = (
    "Realtime emotion contract:\n"
    "- Prefix every live voice reply with exactly one short emotion code and a pipe: "
    "N| neutral, F| friendly, C| careful, P| confident, S| sympathetic, E| energetic.\n"
    "- The runtime strips the code before speech, so do not explain it.\n"
    "- If the user explicitly requested a tone or speaking style, keep that tone until they ask to change or reset it.\n"
    "- Use E for speed or urgency requests, S when the user sounds frustrated, "
    "C for corrections/confirmations/safety, F for greetings, P for completed work, "
    "and N otherwise."
)

VOICE_EMOTION_TTS_INSTRUCTIONS = {
    "neutral": "Neutral, clear, and concise.",
    "friendly": "Friendly and warm, with natural pace.",
    "careful": "Careful and clear, with precise articulation.",
    "confident": "Confident and direct.",
    "sympathetic": "Patient and sympathetic, without sounding slow.",
    "energetic": "Brisk, upbeat, and fast while staying clear.",
    "calm": "Calm, steady, and grounded.",
    "spooky": "Low, suspenseful, and eerie while remaining understandable.",
    "arrogant": "Confident and slightly smug without insulting the user.",
    "condescending": "Dry and superior in tone without being hostile.",
    "whisper": (
        "Use a whisper-like delivery: very soft, breathy, close-mic, and quiet, "
        "while staying intelligible. Reduce projection and avoid a normal speaking voice."
    ),
}

VOICE_TONE_ALIASES: dict[str, VoiceTone] = {
    "neutral": "neutral",
    "normal": "neutral",
    "friendly": "friendly",
    "warm": "friendly",
    "careful": "careful",
    "precise": "careful",
    "confident": "confident",
    "assertive": "confident",
    "sympathetic": "sympathetic",
    "empathetic": "sympathetic",
    "sorry": "sympathetic",
    "energetic": "energetic",
    "excited": "energetic",
    "upbeat": "energetic",
    "calm": "calm",
    "relaxed": "calm",
    "spooky": "spooky",
    "scary": "spooky",
    "creepy": "spooky",
    "arrogant": "arrogant",
    "smug": "arrogant",
    "condescending": "condescending",
    "whisper": "whisper",
    "whispering": "whisper",
}


def normalize_for_intent(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def voice_speed_intent(text: str) -> VoiceSpeedIntent | None:
    normalized = normalize_for_intent(text)
    if not normalized:
        return None

    words = set(normalized.split())
    has_voice_context = bool(
        words
        & {
            "talk",
            "speak",
            "speaking",
            "speech",
            "voice",
            "talking",
            "said",
            "say",
        }
    )
    speed_context = (
        has_voice_context
        or "speed up" in normalized
        or "slow down" in normalized
        or normalized in {"faster", "very fast", "fast", "slower", "slow"}
    )
    if not speed_context:
        return None

    if "too slow" in normalized or "speaking too slow" in normalized or "talking too slow" in normalized:
        return "faster"
    if "too fast" in normalized or "speaking too fast" in normalized or "talking too fast" in normalized:
        return "slower"
    if (
        "normal speed" in normalized
        or "regular speed" in normalized
        or "default speed" in normalized
        or "usual speed" in normalized
    ):
        return "normal"
    if (
        "very slow" in normalized
        or "very slowly" in normalized
        or "much slower" in normalized
        or "super slow" in normalized
    ):
        return "very_slow"
    if (
        "slower" in words
        or "slowly" in words
        or "slow down" in normalized
        or normalized == "slow"
        or ("slow" in words and has_voice_context)
    ):
        return "slower"
    if (
        "very fast" in normalized
        or "really fast" in normalized
        or "super fast" in normalized
        or "much faster" in normalized
    ):
        return "very_fast"
    if (
        "faster" in words
        or "quicker" in words
        or "speed up" in normalized
        or ("fast" in words and has_voice_context)
    ):
        return "faster"
    return None


def voice_tone_intent(text: str) -> VoiceTone | None:
    normalized = normalize_for_intent(text)
    if not normalized:
        return None

    words = set(normalized.split())
    has_tone_context = bool(
        words
        & {
            "tone",
            "voice",
            "sound",
            "sounds",
            "speak",
            "talk",
            "talking",
            "style",
            "vibe",
        }
    ) or any(
        phrase in normalized
        for phrase in [
            "be more",
            "make it",
            "can you be",
            "sound more",
            "talk like",
            "speak like",
        ]
    )
    for alias, tone in VOICE_TONE_ALIASES.items():
        if alias in words and (has_tone_context or alias in {"whisper", "whispering"}):
            return tone
    return None


def voice_tone_response(tone: VoiceTone) -> str:
    if tone == "whisper":
        return "Got it, I'll use a whisper-like tone."
    return f"Got it, I'll use a {tone} tone."


def emotion_code_for_tone(tone: str) -> VoiceEmotionCode:
    if tone in {"friendly"}:
        return "F"
    if tone in {"careful", "calm", "spooky", "whisper"}:
        return "C"
    if tone in {"confident", "arrogant", "condescending"}:
        return "P"
    if tone in {"sympathetic"}:
        return "S"
    if tone in {"energetic"}:
        return "E"
    return "N"


def next_voice_speed(current: float, intent: VoiceSpeedIntent) -> float:
    if intent == "very_fast":
        return 1.6
    if intent == "faster":
        return min(1.6, current + 0.2)
    if intent == "very_slow":
        return 0.75
    if intent == "slower":
        return max(0.75, current - 0.2)
    return 1.0


def voice_speed_label(speed: float) -> str:
    if speed >= 1.5:
        return "very_fast"
    if speed > 1.05:
        return "fast"
    if speed <= 0.82:
        return "very_slow"
    if speed < 0.95:
        return "slow"
    return "normal"


def emotion_code_for_turn(user_text: str, response_text: str) -> VoiceEmotionCode:
    normalized_user = normalize_for_intent(user_text)
    normalized_response = normalize_for_intent(response_text)
    if tone := voice_tone_intent(user_text):
        return emotion_code_for_tone(tone)
    if voice_speed_intent(user_text):
        return "E"
    if any(
        phrase in normalized_user
        for phrase in [
            "not talking",
            "wrong",
            "incorrect",
            "bad",
            "damn",
            "what is going on",
            "whats going on",
        ]
    ):
        return "S"
    if any(word in normalized_response for word in ["confirm", "correct", "careful"]):
        return "C"
    if any(word in normalized_response for word in ["done", "finished", "completed", "saved"]):
        return "P"
    if normalized_user in {"hi", "hello", "hey"} or "how are you" in normalized_user:
        return "F"
    return "N"


def prefix_emotion_code(text: str, code: VoiceEmotionCode) -> str:
    stripped = text.strip()
    if not stripped:
        return stripped
    if re.match(r"^[NFCPSE]\s*\|", stripped, flags=re.IGNORECASE):
        return stripped
    return f"{code}|{stripped}"


def consume_emotion_prefix(buffer: str) -> tuple[str, VoiceEmotionCode | None, str]:
    """Return (status, code, text), where status is pending, matched, or none."""

    if not buffer:
        return "pending", None, ""

    stripped = buffer.lstrip()
    if not stripped:
        return "pending", None, ""

    match = re.match(r"^([NFCPSE])\s*\|\s*(.*)$", stripped, flags=re.IGNORECASE | re.DOTALL)
    if match:
        code = match.group(1).upper().replace(" ", "")
        if code in VOICE_EMOTION_CODES:
            return "matched", code, match.group(2)

    if len(stripped) <= 3 and re.fullmatch(r"[A-Za-z]?\s*\|?", stripped):
        return "pending", None, ""

    return "none", None, buffer
