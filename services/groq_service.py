import os
from datetime import datetime, timezone
from pathlib import Path

from groq import Groq

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB (Groq limit)

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
    """Return the rate-limit info captured from the most recent Groq API call."""
    return _last_usage


def transcribe_file(
    file_path: str,
    language: str = "auto",
    model: str = "whisper-large-v3-turbo",
) -> dict:
    """
    Blocking call — run via asyncio.to_thread() from async context.
    Returns plain dict (JSON-serialisable).
    """
    global _last_usage

    client = get_client()
    path = Path(file_path)

    size = path.stat().st_size
    if size > MAX_FILE_SIZE:
        raise ValueError(
            f"File too large: {size / 1024 / 1024:.1f} MB. Max allowed is 25 MB."
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
            file=(path.name, f),
            **params,
        )

    # ── Capture rate-limit headers ────────────────────────────────────────────
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
        "requests_limit":     req_limit,
        "requests_remaining": req_remaining,
        "requests_used":      (req_limit - req_remaining) if (req_limit is not None and req_remaining is not None) else None,
        "requests_reset":     hdrs.get("x-ratelimit-reset-requests"),
        "tokens_limit":       tok_limit,
        "tokens_remaining":   tok_remaining,
        "tokens_used":        (tok_limit - tok_remaining) if (tok_limit is not None and tok_remaining is not None) else None,
        "tokens_reset":       hdrs.get("x-ratelimit-reset-tokens"),
        "last_updated":       datetime.now(timezone.utc).isoformat(),
    }

    # ── Parse response ────────────────────────────────────────────────────────
    response = raw.parse()

    # Convert Pydantic/SDK objects → plain dicts for JSON serialisation.
    # Newer Groq SDK versions may return dicts directly; older ones return objects.
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
