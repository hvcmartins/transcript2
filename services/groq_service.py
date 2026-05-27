import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from groq import Groq

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB (Groq API hard limit)

# At 32 kbps mono the effective limit is ~104 minutes of audio.
# Files that are STILL over 25 MB after compression are too long.
PREPROCESS_BITRATE = "32k"

SUPPORTED_MODELS = [
    {"id": "whisper-large-v3-turbo", "label": "Whisper Large v3 Turbo (fast)"},
    {"id": "whisper-large-v3",       "label": "Whisper Large v3 (accurate)"},
    {"id": "distil-whisper-large-v3-en", "label": "Distil Whisper (English only, fastest)"},
]

SUPPORTED_LANGUAGES = [
    {"code": "auto", "label": "Auto-detect"},
    {"code": "en",   "label": "English"},
    {"code": "es",   "label": "Spanish"},
    {"code": "fr",   "label": "French"},
    {"code": "de",   "label": "German"},
    {"code": "pt",   "label": "Portuguese"},
    {"code": "it",   "label": "Italian"},
    {"code": "nl",   "label": "Dutch"},
    {"code": "pl",   "label": "Polish"},
    {"code": "ru",   "label": "Russian"},
    {"code": "zh",   "label": "Chinese"},
    {"code": "ja",   "label": "Japanese"},
    {"code": "ko",   "label": "Korean"},
    {"code": "ar",   "label": "Arabic"},
    {"code": "hi",   "label": "Hindi"},
    {"code": "tr",   "label": "Turkish"},
    {"code": "uk",   "label": "Ukrainian"},
    {"code": "sv",   "label": "Swedish"},
    {"code": "da",   "label": "Danish"},
    {"code": "fi",   "label": "Finnish"},
    {"code": "nb",   "label": "Norwegian"},
    {"code": "id",   "label": "Indonesian"},
    {"code": "ms",   "label": "Malay"},
    {"code": "th",   "label": "Thai"},
    {"code": "vi",   "label": "Vietnamese"},
]

_client: Groq | None = None
_last_usage: dict = {}


def get_client() -> Groq:
    global _client
    if not _client:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise ValueError("GROQ_API_KEY environment variable is not set")
        _client = Groq(api_key=api_key)
    return _client


def get_last_usage() -> dict:
    """Return rate-limit info captured from the most recent Groq API call."""
    return _last_usage


# ── Audio preprocessing ───────────────────────────────────────────────────────
def preprocess_audio(file_path: str) -> tuple[str, bool]:
    """
    Convert any audio/video to 16 kHz mono MP3 at 32 kbps using ffmpeg.

    This strips the video track and dramatically reduces file size:
    - 1 hour of audio  →  ~14 MB  (well under the 25 MB Groq limit)
    - 2 hours of audio →  ~28 MB  (just over — Groq will reject it)

    Returns (processed_path, is_temp).
    Caller must os.unlink(processed_path) when is_temp=True.
    Falls back to the original file if ffmpeg is unavailable or fails.
    """
    try:
        tmp = tempfile.mktemp(suffix=".mp3")
        result = subprocess.run(
            [
                "ffmpeg", "-i", file_path,
                "-vn",                    # strip video
                "-ar", "16000",           # 16 kHz — optimal for Whisper
                "-ac", "1",               # mono
                "-b:a", PREPROCESS_BITRATE,
                "-y", tmp,
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            return file_path, False       # ffmpeg failed → use original

        orig_size = Path(file_path).stat().st_size
        proc_size = Path(tmp).stat().st_size

        if proc_size == 0 or proc_size >= orig_size:
            os.unlink(tmp)
            return file_path, False       # original already optimal

        return tmp, True

    except (FileNotFoundError, OSError):
        return file_path, False           # ffmpeg not installed


# ── Transcription ─────────────────────────────────────────────────────────────
def transcribe_file(
    file_path: str,
    language: str = "auto",
    model: str = "whisper-large-v3-turbo",
) -> dict:
    """
    Blocking call — run via asyncio.to_thread() from async context.
    Expects file_path to already be preprocessed (use preprocess_audio() first).
    Returns plain dict (JSON-serialisable).
    """
    global _last_usage

    client = get_client()
    path = Path(file_path)

    size = path.stat().st_size
    if size > MAX_FILE_SIZE:
        minutes = size / 1024 / 1024 / (int(PREPROCESS_BITRATE[:-1]) / 8 * 60 / 1000)
        raise ValueError(
            f"Audio is too long even after compression "
            f"({size / 1024 / 1024:.0f} MB). "
            f"Try splitting the file — Groq supports up to ~104 minutes at 32 kbps."
        )

    params: dict = {
        "model": model,
        "response_format": "verbose_json",
        "timestamp_granularities": ["segment", "word"],
    }
    if language and language != "auto":
        params["language"] = language

    with open(file_path, "rb") as f:
        raw = client.audio.transcriptions.with_raw_response.create(
            file=("audio.mp3", f),   # filename tells Groq the codec
            **params,
        )

    # ── Capture rate-limit headers ────────────────────────────────────────────
    # x-ratelimit-limit-requests   / remaining / reset  → daily (RPD) window
    # x-ratelimit-limit-tokens     / remaining / reset  → per-minute (TPM) window
    hdrs = raw.headers

    def _int(key: str) -> int | None:
        v = hdrs.get(key)
        try:
            return int(v) if v is not None else None
        except (ValueError, TypeError):
            return None

    req_limit     = _int("x-ratelimit-limit-requests")
    req_remaining = _int("x-ratelimit-remaining-requests")
    tok_limit     = _int("x-ratelimit-limit-tokens")
    tok_remaining = _int("x-ratelimit-remaining-tokens")

    _last_usage = {
        # Daily requests (RPD)
        "requests_limit":     req_limit,
        "requests_remaining": req_remaining,
        "requests_used":      (req_limit - req_remaining) if (req_limit is not None and req_remaining is not None) else None,
        "requests_reset":     hdrs.get("x-ratelimit-reset-requests"),
        # Per-minute audio seconds (TPM)
        "tokens_limit":       tok_limit,
        "tokens_remaining":   tok_remaining,
        "tokens_used":        (tok_limit - tok_remaining) if (tok_limit is not None and tok_remaining is not None) else None,
        "tokens_reset":       hdrs.get("x-ratelimit-reset-tokens"),
        "last_updated":       datetime.now(timezone.utc).isoformat(),
    }

    # ── Parse response ────────────────────────────────────────────────────────
    response = raw.parse()

    def _get(obj, key, default=None):
        return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)

    segments = []
    for seg in response.segments or []:
        segments.append({
            "start": _get(seg, "start", 0),
            "end":   _get(seg, "end",   0),
            "text":  _get(seg, "text",  ""),
        })

    words = []
    for w in getattr(response, "words", None) or []:
        words.append({
            "word":  _get(w, "word",  ""),
            "start": _get(w, "start", 0),
            "end":   _get(w, "end",   0),
        })

    return {
        "text":     response.text or "",
        "segments": segments,
        "words":    words,
        "duration": getattr(response, "duration", 0) or 0,
        "language": getattr(response, "language", language) or language,
    }
