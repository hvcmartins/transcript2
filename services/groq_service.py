import os
import subprocess
import tempfile
import time
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
def _get_audio_duration(file_path: str) -> float | None:
    """Use ffprobe to get audio duration in seconds."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", file_path],
            capture_output=True, text=True, timeout=30,
        )
        val = r.stdout.strip()
        return float(val) if val else None
    except Exception:
        return None


def _read_ffmpeg_progress(prog_path: str, duration_s: float) -> int | None:
    """Parse ffmpeg -progress file to get 0-99 percentage."""
    try:
        with open(prog_path) as f:
            content = f.read()
        for line in reversed(content.splitlines()):
            if line.startswith("out_time_ms="):
                val = line.split("=", 1)[1].strip()
                if val and val != "N/A":
                    ms = int(val)
                    if ms >= 0 and duration_s > 0:
                        return min(99, int(ms / 1000 / duration_s * 100))
    except Exception:
        pass
    return None


def preprocess_audio(file_path: str, progress_cb=None) -> tuple[str, bool]:
    """
    Convert any audio/video to 16 kHz mono MP3 at 32 kbps using ffmpeg.
    Applies background noise reduction (afftdn) and speech enhancement (highpass + loudnorm).
    Only the compressed output is kept — the original is deleted by the caller.

    progress_cb(pct: int) is called with 0-100 during conversion when provided.
    Returns (processed_path, is_temp).
    Caller must os.unlink(processed_path) when is_temp=True.
    Falls back to the original file if ffmpeg is unavailable or fails.
    """
    try:
        tmp = tempfile.mktemp(suffix=".mp3")
        prog_path = tempfile.mktemp(suffix=".txt") if progress_cb else None

        cmd = [
            "ffmpeg", "-i", file_path,
            "-vn",
            "-af", "highpass=f=80,afftdn=nf=-25,loudnorm",
            "-ar", "16000",
            "-ac", "1",
            "-b:a", PREPROCESS_BITRATE,
        ]
        if prog_path:
            cmd += ["-progress", prog_path]
        cmd += ["-y", tmp]

        if progress_cb:
            duration_s = _get_audio_duration(file_path)
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            while proc.poll() is None:
                if duration_s and prog_path:
                    pct = _read_ffmpeg_progress(prog_path, duration_s)
                    if pct is not None:
                        progress_cb(pct)
                time.sleep(0.4)
            if prog_path:
                Path(prog_path).unlink(missing_ok=True)
            returncode = proc.returncode
            if returncode == 0:
                progress_cb(100)
        else:
            result = subprocess.run(cmd, capture_output=True)
            returncode = result.returncode

        if returncode != 0:
            return file_path, False

        orig_size = Path(file_path).stat().st_size
        proc_size = Path(tmp).stat().st_size

        if proc_size == 0 or proc_size >= orig_size:
            os.unlink(tmp)
            return file_path, False

        return tmp, True

    except (FileNotFoundError, OSError):
        return file_path, False


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
