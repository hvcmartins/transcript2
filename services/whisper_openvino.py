"""
Intel GPU transcription via optimum-intel + OpenVINO.

Uses model.generate() directly as recommended by transformers for Whisper —
the pipeline abstraction doesn't handle seq2seq chunking correctly.

Requirements: pip install optimum[openvino] transformers
Build with Dockerfile.openvino (Ubuntu 24.04 + Intel GPU drivers).

Environment variables:
  MODELS_DIR      — HuggingFace cache root  (default: models)
  OPENVINO_DEVICE — "GPU" | "CPU" | "AUTO"  (default: AUTO)
"""

import os
import re
from pathlib import Path

MODELS_DIR      = Path(os.getenv("MODELS_DIR", "models"))
OPENVINO_DEVICE = os.getenv("OPENVINO_DEVICE", "AUTO")

_HF_CACHE = MODELS_DIR / "openvino_hf"

SUPPORTED_OV_MODELS = [
    {"id": "tiny",           "hf_id": "OpenVINO/whisper-tiny-int8-ov",            "label": "Tiny — ~40 MB · fastest"},
    {"id": "base",           "hf_id": "OpenVINO/whisper-base-int8-ov",            "label": "Base — ~80 MB · fast"},
    {"id": "small",          "hf_id": "OpenVINO/whisper-small-int8-ov",           "label": "Small — ~240 MB · balanced ✓"},
    {"id": "medium",         "hf_id": "OpenVINO/whisper-medium-int8-ov",          "label": "Medium — ~780 MB · accurate"},
    {"id": "large-v3-turbo", "hf_id": "OpenVINO/whisper-large-v3-turbo-int8-ov", "label": "Large v3 Turbo — ~900 MB · fast+accurate"},
    {"id": "large-v3",       "hf_id": "OpenVINO/whisper-large-v3-int8-ov",       "label": "Large v3 — ~1.6 GB · best"},
]

_model_cache: dict = {}


def _hf_id(model_id: str) -> str:
    for m in SUPPORTED_OV_MODELS:
        if m["id"] == model_id:
            return m["hf_id"]
    return f"OpenVINO/whisper-{model_id}-int8-ov"


def _is_available() -> bool:
    try:
        from optimum.intel import OVModelForSpeechSeq2Seq  # noqa: F401
        return True
    except ImportError:
        return False


OPENVINO_AVAILABLE = _is_available()


def is_ov_model_cached(model_id: str) -> bool:
    cache_name = "models--" + _hf_id(model_id).replace("/", "--")
    model_dir = _HF_CACHE / cache_name
    return model_dir.exists() and any(model_dir.iterdir())


def _load(model_id: str):
    """Load and cache (model, processor) pair."""
    global _model_cache
    if model_id not in _model_cache:
        from optimum.intel import OVModelForSpeechSeq2Seq
        from transformers import AutoProcessor

        hf_id = _hf_id(model_id)
        _HF_CACHE.mkdir(parents=True, exist_ok=True)

        model = OVModelForSpeechSeq2Seq.from_pretrained(
            hf_id,
            device=OPENVINO_DEVICE,
            cache_dir=str(_HF_CACHE),
        )
        processor = AutoProcessor.from_pretrained(
            hf_id,
            cache_dir=str(_HF_CACHE),
        )
        _model_cache[model_id] = (model, processor)
    return _model_cache[model_id]


_TS_RE = re.compile(r"<\|[\d.]+\|>")

_CHUNK   = 30 * 16000   # 30 s at 16 kHz


def transcribe_openvino(
    file_path: str,
    language: str = "auto",
    model_id: str = "small",
    progress_cb=None,
) -> dict:
    """
    Blocking — run via asyncio.to_thread() from an async context.
    Returns the same dict shape as groq_service.transcribe_file().
    """
    if not OPENVINO_AVAILABLE:
        raise RuntimeError(
            "optimum-intel is not installed. Build the image with Dockerfile.openvino."
        )

    import librosa
    import numpy as np

    if progress_cb:
        progress_cb(32)

    model, processor = _load(model_id)

    audio, _ = librosa.load(file_path, sr=16000, mono=True)
    duration  = float(len(audio)) / 16000.0

    if progress_cb:
        progress_cb(38)

    # Generation kwargs
    gen_kwargs: dict = {"return_timestamps": True}
    if language and language != "auto":
        gen_kwargs["language"] = language
        gen_kwargs["task"]     = "transcribe"

    # Split into 30-second chunks (Whisper's native input window)
    positions = list(range(0, max(1, len(audio)), _CHUNK))
    segments:    list[dict] = []
    text_parts:  list[str]  = []

    for i, pos in enumerate(positions):
        chunk = audio[pos : pos + _CHUNK].astype(np.float32)
        # Pad final chunk to exactly 30 s
        if len(chunk) < _CHUNK:
            chunk = np.pad(chunk, (0, _CHUNK - len(chunk)))

        offset_s = pos / 16000.0

        input_features = processor.feature_extractor(
            chunk, sampling_rate=16000, return_tensors="pt"
        ).input_features

        ids = model.generate(input_features, **gen_kwargs)

        # Decode with timestamp offsets
        decoded = processor.batch_decode(
            ids,
            output_offsets=True,
            time_precision=0.02,
            skip_special_tokens=False,
        )
        chunk_result = decoded[0] if decoded else {}

        raw_text   = chunk_result.get("text") or ""
        raw_offsets = chunk_result.get("offsets") or []

        for seg in raw_offsets:
            ts    = seg.get("offset") or (0.0, 0.0)
            start = float(ts[0] if ts[0] is not None else 0.0) + offset_s
            end   = float(ts[1] if ts[1] is not None else start) + offset_s
            text  = _TS_RE.sub("", seg.get("text") or "").strip()
            if text:
                segments.append({"start": start, "end": end, "text": text})

        clean = _TS_RE.sub("", raw_text).strip()
        if clean:
            text_parts.append(clean)

        if progress_cb:
            pct = 38 + int((i + 1) / len(positions) * 45)
            progress_cb(min(83, pct))

    full_text = " ".join(text_parts).strip()

    if not segments:
        segments = [{"start": 0.0, "end": duration, "text": full_text}]

    return {
        "text":     full_text,
        "segments": segments,
        "words":    [],
        "duration": duration,
        "language": language,
    }
