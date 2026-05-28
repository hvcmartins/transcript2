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


def _parse_wait_seconds(reset_str: str | None, default: float = 62.0) -> float:
    """Parse Groq reset header like '1m30s', '45s', '2h' → seconds."""
    if not reset_str:
        return default
    import re
    total = 0.0
    for m in re.finditer(r'(\d+(?:\.\d+)?)([hms])', reset_str):
        val, unit = float(m.group(1)), m.group(2)
        total += val * {'h': 3600, 'm': 60, 's': 1}[unit]
    return total if total > 0 else default


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
def get_audio_duration(file_path: str) -> float | None:
    """Use ffprobe to get audio/video duration in seconds."""
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
    Tries with noise-reduction filters first; falls back to plain conversion if filters fail.
    Always returns a properly formatted 16 kHz mono MP3 (never the raw original).

    progress_cb(pct: int) is called with 0-100 during conversion when provided.
    Returns (processed_path, is_temp).  is_temp is always True on success.
    Raises RuntimeError if ffmpeg is unavailable or both attempts fail.
    """
    def _run_cmd(cmd: list[str], use_progress: bool) -> int:
        if use_progress and progress_cb:
            duration_s = get_audio_duration(file_path)
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            while proc.poll() is None:
                if duration_s and prog_path:
                    pct = _read_ffmpeg_progress(prog_path, duration_s)
                    if pct is not None:
                        progress_cb(pct)
                time.sleep(0.4)
            return proc.returncode
        else:
            return subprocess.run(cmd, capture_output=True).returncode

    tmp = tempfile.mktemp(suffix=".mp3")
    prog_path = tempfile.mktemp(suffix=".txt") if progress_cb else None

    def _build_cmd(filters: list[str]) -> list[str]:
        cmd = ["ffmpeg", "-i", file_path, "-vn"]
        if filters:
            cmd += ["-af", ",".join(filters)]
        cmd += ["-ar", "16000", "-ac", "1", "-b:a", PREPROCESS_BITRATE]
        if prog_path:
            cmd += ["-progress", prog_path]
        cmd += ["-y", tmp]
        return cmd

    try:
        # Attempt 1: with noise-reduction filters
        returncode = _run_cmd(_build_cmd(["highpass=f=80", "afftdn=nf=-25"]), use_progress=True)

        if returncode != 0:
            # Attempt 2: plain conversion without filters (handles edge-case audio formats)
            if prog_path:
                Path(prog_path).unlink(missing_ok=True)
            returncode = _run_cmd(_build_cmd([]), use_progress=True)

        if prog_path:
            Path(prog_path).unlink(missing_ok=True)

        if returncode != 0 or not Path(tmp).exists() or Path(tmp).stat().st_size == 0:
            Path(tmp).unlink(missing_ok=True)
            raise RuntimeError("ffmpeg failed to convert audio")

        if progress_cb:
            progress_cb(100)

        return tmp, True

    except (FileNotFoundError, OSError) as exc:
        Path(tmp).unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg not available: {exc}") from exc


# ── Audio splitting ───────────────────────────────────────────────────────────
SPLIT_DURATION_S = 90 * 60  # split files longer than 90 minutes


def detect_silence(file_path: str) -> list[tuple[float, float]]:
    """Return (start, end) silence intervals detected by ffmpeg silencedetect."""
    try:
        r = subprocess.run(
            ["ffmpeg", "-i", file_path,
             "-af", "silencedetect=noise=-40dB:duration=0.3",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=300,
        )
        silences: list[tuple[float, float]] = []
        start: float | None = None
        for line in r.stderr.splitlines():
            if "silence_start:" in line:
                try:
                    start = float(line.split("silence_start:")[1].strip())
                except ValueError:
                    pass
            elif "silence_end:" in line and start is not None:
                try:
                    end = float(line.split("silence_end:")[1].split("|")[0].strip())
                    silences.append((start, end))
                    start = None
                except ValueError:
                    pass
        return silences
    except Exception:
        return []


def _find_split_point(silences: list[tuple[float, float]], target: float, window: float = 60.0) -> float:
    """Return midpoint of silence closest to `target` within `window` seconds, or `target` if none."""
    best, best_dist = None, float("inf")
    for s, e in silences:
        mid = (s + e) / 2
        dist = abs(mid - target)
        if dist <= window and dist < best_dist:
            best, best_dist = mid, dist
    return best if best is not None else target


def _split_audio(file_path: str, duration_s: float) -> list[tuple[str, float]]:
    """
    Split audio into ≤90-min chunks at silence zones.
    Returns [(tmp_path, start_offset_s), ...].  Caller must delete tmp files.
    Returns [(file_path, 0.0)] unchanged if file is short enough.
    """
    if duration_s <= SPLIT_DURATION_S:
        return [(file_path, 0.0)]

    silences = detect_silence(file_path)

    split_points: list[float] = []
    pos = 0.0
    while pos + SPLIT_DURATION_S < duration_s - 30:
        target = pos + SPLIT_DURATION_S
        sp = _find_split_point(silences, target)
        if sp <= pos:
            sp = target
        split_points.append(sp)
        pos = sp

    starts = [0.0] + split_points
    ends   = split_points + [duration_s]

    chunks: list[tuple[str, float]] = []
    for i, (start, end) in enumerate(zip(starts, ends)):
        tmp = tempfile.mktemp(suffix=".mp3")
        r = subprocess.run(
            ["ffmpeg", "-ss", str(start), "-i", file_path,
             "-t", str(end - start), "-c", "copy", "-y", tmp],
            capture_output=True,
        )
        if r.returncode != 0 or not Path(tmp).exists() or Path(tmp).stat().st_size == 0:
            for p, _ in chunks:
                Path(p).unlink(missing_ok=True)
            Path(tmp).unlink(missing_ok=True)
            raise RuntimeError(f"Failed to extract audio chunk {i + 1}/{len(starts)}")
        chunks.append((tmp, start))

    return chunks


# ── Transcription ─────────────────────────────────────────────────────────────
def _call_groq(client, file_path: str, language: str, model: str) -> dict:
    """Single Groq API call. Updates _last_usage. Returns parsed result dict."""
    global _last_usage

    params: dict = {
        "model": model,
        "response_format": "verbose_json",
        "timestamp_granularities": ["segment", "word"],
    }
    if language and language != "auto":
        params["language"] = language

    with open(file_path, "rb") as f:
        raw = client.audio.transcriptions.with_raw_response.create(
            file=("audio.mp3", f),
            **params,
        )

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

    response = raw.parse()

    def _get(obj, key, default=None):
        return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)

    segments = []
    for seg in response.segments or []:
        segments.append({
            "start":       _get(seg, "start", 0),
            "end":         _get(seg, "end",   0),
            "text":        _get(seg, "text",  ""),
            "avg_logprob": _get(seg, "avg_logprob", None),
        })

    words = []
    for w in getattr(response, "words", None) or []:
        words.append({
            "word":        _get(w, "word",  ""),
            "start":       _get(w, "start", 0),
            "end":         _get(w, "end",   0),
            "probability": _get(w, "probability", None),
        })

    return {
        "text":     response.text or "",
        "segments": segments,
        "words":    words,
        "duration": getattr(response, "duration", 0) or 0,
        "language": getattr(response, "language", language) or language,
    }


def transcribe_file(
    file_path: str,
    language: str = "auto",
    model: str = "whisper-large-v3-turbo",
    progress_cb=None,
) -> dict:
    """
    Blocking call — run via asyncio.to_thread() from async context.
    Expects file_path to already be preprocessed (use preprocess_audio() first).
    Automatically splits files > 90 min into chunks and merges results.
    progress_cb(chunk_num, total_chunks) is called before each chunk when provided.
    Returns plain dict (JSON-serialisable).
    """
    client = get_client()

    duration_s = get_audio_duration(file_path) or 0
    chunks = _split_audio(file_path, duration_s)
    total  = len(chunks)

    try:
        results: list[tuple[dict, float]] = []
        for i, (chunk_path, time_offset) in enumerate(chunks):
            chunk_size = Path(chunk_path).stat().st_size
            if chunk_size > MAX_FILE_SIZE:
                raise ValueError(
                    f"Audio chunk {i + 1}/{total} is {chunk_size / 1024 / 1024:.0f} MB — "
                    f"exceeds Groq's 25 MB limit. The recording may be too long even after splitting."
                )
            if progress_cb:
                progress_cb(i + 1, total)
            for _attempt in range(4):
                try:
                    results.append((_call_groq(client, chunk_path, language, model), time_offset))
                    break
                except Exception as _exc:
                    _is_rl = ('ratelimit' in type(_exc).__name__.lower() or '429' in str(_exc))
                    if _is_rl and _attempt < 3:
                        _hdrs = getattr(getattr(_exc, 'response', None), 'headers', {}) or {}
                        _wait = _parse_wait_seconds(
                            _hdrs.get('x-ratelimit-reset-tokens') or _hdrs.get('x-ratelimit-reset-requests')
                        )
                        print(f"[groq] rate limited on chunk {i+1}/{total}; waiting {_wait:.0f}s (attempt {_attempt+1}/4)")
                        time.sleep(min(_wait + 2, 300))
                    else:
                        raise
    finally:
        for chunk_path, _ in chunks:
            if chunk_path != file_path:
                Path(chunk_path).unlink(missing_ok=True)

    if len(results) == 1:
        return results[0][0]

    # Merge all chunks into one result with corrected timestamps
    merged_text     = " ".join(r["text"].strip() for r, _ in results if r["text"].strip())
    merged_segments: list[dict] = []
    merged_words:    list[dict] = []
    total_duration  = 0.0

    for result, offset in results:
        for seg in result["segments"]:
            merged_segments.append({
                "start":       round(seg["start"] + offset, 3),
                "end":         round(seg["end"]   + offset, 3),
                "text":        seg["text"],
                "avg_logprob": seg.get("avg_logprob"),
            })
        for w in result["words"]:
            merged_words.append({
                "word":        w["word"],
                "start":       round(w["start"] + offset, 3),
                "end":         round(w["end"]   + offset, 3),
                "probability": w.get("probability"),
            })
        total_duration = max(total_duration, offset + result["duration"])

    return {
        "text":     merged_text,
        "segments": merged_segments,
        "words":    merged_words,
        "duration": total_duration,
        "language": results[0][0]["language"],
    }
