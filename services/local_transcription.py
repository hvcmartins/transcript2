"""
Local CPU transcription using faster-whisper (CTranslate2 backend).

No GPU required — INT8 quantisation runs well on Intel CPUs with AVX2/VNNI
(e.g. Core i5-14400).  Models are downloaded once and cached in MODELS_DIR.

Environment variables
─────────────────────
  MODELS_DIR          Where model weights are stored  (default: /app/models)
  LOCAL_DEVICE        "cpu" or "cuda"                  (default: cpu)
  LOCAL_COMPUTE_TYPE  "int8" | "int8_float16" | "float32"
                       int8 is fastest on Intel CPUs   (default: int8)
"""

import os
from pathlib import Path

MODELS_DIR = Path(os.getenv("MODELS_DIR", "models"))
MODELS_DIR.mkdir(parents=True, exist_ok=True)

LOCAL_DEVICE       = os.getenv("LOCAL_DEVICE",       "cpu")
LOCAL_COMPUTE_TYPE = os.getenv("LOCAL_COMPUTE_TYPE", "int8")

SUPPORTED_LOCAL_MODELS = [
    {"id": "tiny",     "label": "Tiny — 75 MB  · fastest (low accuracy)"},
    {"id": "base",     "label": "Base — 142 MB · fast"},
    {"id": "small",    "label": "Small — 466 MB · balanced  ✓ recommended"},
    {"id": "medium",   "label": "Medium — 1.5 GB · accurate"},
    {"id": "large-v3", "label": "Large v3 — 3 GB · best accuracy"},
]

# Module-level cache so each model is loaded only once per container lifetime
_model_cache: dict = {}


def is_model_cached(model_size: str) -> bool:
    """Return True if the model weights are already on disk."""
    # faster-whisper stores models under MODELS_DIR/models--Systran--faster-whisper-{size}
    model_dir = MODELS_DIR / f"models--Systran--faster-whisper-{model_size}"
    return model_dir.exists() and any(model_dir.iterdir())


def get_model(model_size: str):
    """Load (or reuse) a WhisperModel instance."""
    global _model_cache
    if model_size not in _model_cache:
        from faster_whisper import WhisperModel
        _model_cache[model_size] = WhisperModel(
            model_size,
            device=LOCAL_DEVICE,
            compute_type=LOCAL_COMPUTE_TYPE,
            download_root=str(MODELS_DIR),
        )
    return _model_cache[model_size]


def transcribe_locally(
    file_path: str,
    language: str = "auto",
    model_size: str = "small",
    progress_cb=None,           # optional callable(pct: int)
) -> dict:
    """
    Blocking call — run via asyncio.to_thread() from async context.
    Returns the same dict shape as groq_service.transcribe_file().
    """
    model = get_model(model_size)

    kwargs: dict = {
        "beam_size":       5,
        "word_timestamps": True,
        "vad_filter":      True,   # skip silence — faster + cleaner
    }
    if language and language != "auto":
        kwargs["language"] = language

    segments_gen, info = model.transcribe(file_path, **kwargs)

    segments: list[dict] = []
    words:    list[dict] = []
    text_parts: list[str] = []
    duration = info.duration or 0

    for seg in segments_gen:
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text})
        text_parts.append(seg.text)

        if seg.words:
            for w in seg.words:
                words.append({"word": w.word, "start": w.start, "end": w.end})

        # Report progress proportional to audio position (30 – 88 %)
        if progress_cb and duration > 0:
            pct = 30 + int(min(seg.end / duration, 1.0) * 58)
            progress_cb(pct)

    return {
        "text":     "".join(text_parts),
        "segments": segments,
        "words":    words,
        "duration": duration,
        "language": info.language or language,
    }
