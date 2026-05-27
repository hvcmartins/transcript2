import os
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


def get_client() -> Groq:
    global _client
    if not _client:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise ValueError("GROQ_API_KEY environment variable is not set")
        _client = Groq(api_key=api_key)
    return _client


def transcribe_file(
    file_path: str,
    language: str = "auto",
    model: str = "whisper-large-v3-turbo",
) -> dict:
    """
    Blocking call — run via asyncio.to_thread() from async context.
    Returns plain dict (JSON-serialisable).
    """
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
        response = client.audio.transcriptions.create(
            file=(path.name, f),
            **params,
        )

    # Convert Pydantic/SDK objects → plain dicts for JSON serialisation
    segments = []
    for seg in response.segments or []:
        segments.append({
            "start": seg.start,
            "end":   seg.end,
            "text":  seg.text,
        })

    words = []
    for w in getattr(response, "words", None) or []:
        words.append({
            "word":  w.word,
            "start": w.start,
            "end":   w.end,
        })

    return {
        "text":     response.text or "",
        "segments": segments,
        "words":    words,
        "duration": getattr(response, "duration", 0) or 0,
        "language": getattr(response, "language", language) or language,
    }
