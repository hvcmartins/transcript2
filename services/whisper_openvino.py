"""
Intel GPU transcription via optimum-intel + OpenVINO.

Uses pre-converted Whisper INT8 models from HuggingFace (OpenVINO/* org).
These models were created with optimum-intel and must be loaded with it —
openvino-genai's WhisperPipeline is incompatible with this format.

Requirements: pip install optimum[openvino] transformers
Build with Dockerfile.openvino (Ubuntu 24.04 + Intel GPU drivers).

Environment variables:
  MODELS_DIR      — HuggingFace cache root  (default: models)
  OPENVINO_DEVICE — "GPU" | "CPU" | "AUTO"  (default: AUTO)
"""

import os
from pathlib import Path

MODELS_DIR      = Path(os.getenv("MODELS_DIR", "models"))
OPENVINO_DEVICE = os.getenv("OPENVINO_DEVICE", "AUTO")

_HF_CACHE = MODELS_DIR / "openvino_hf"

SUPPORTED_OV_MODELS = [
    {"id": "tiny",           "hf_id": "OpenVINO/whisper-tiny-int8-ov",               "label": "Tiny — ~40 MB · fastest"},
    {"id": "base",           "hf_id": "OpenVINO/whisper-base-int8-ov",               "label": "Base — ~80 MB · fast"},
    {"id": "small",          "hf_id": "OpenVINO/whisper-small-int8-ov",              "label": "Small — ~240 MB · balanced ✓"},
    {"id": "medium",         "hf_id": "OpenVINO/whisper-medium-int8-ov",             "label": "Medium — ~780 MB · accurate"},
    {"id": "large-v3-turbo", "hf_id": "OpenVINO/whisper-large-v3-turbo-int8-ov",    "label": "Large v3 Turbo — ~900 MB · fast+accurate"},
    {"id": "large-v3",       "hf_id": "OpenVINO/whisper-large-v3-int8-ov",          "label": "Large v3 — ~1.6 GB · best"},
]

_pipeline_cache: dict = {}


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
    hf_id = _hf_id(model_id)
    cache_name = "models--" + hf_id.replace("/", "--")
    model_dir = _HF_CACHE / cache_name
    return model_dir.exists() and any(model_dir.iterdir())


def _get_pipeline(model_id: str):
    global _pipeline_cache
    if model_id not in _pipeline_cache:
        from optimum.intel import OVModelForSpeechSeq2Seq
        from transformers import AutoProcessor, pipeline as hf_pipeline

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
        _pipeline_cache[model_id] = hf_pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            max_new_tokens=448,
            return_timestamps=True,
        )
    return _pipeline_cache[model_id]


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

    if progress_cb:
        progress_cb(32)

    pipe = _get_pipeline(model_id)

    audio, _ = librosa.load(file_path, sr=16000, mono=True)
    duration  = float(len(audio)) / 16000.0

    if progress_cb:
        progress_cb(38)

    gen_kwargs: dict = {}
    if language and language != "auto":
        gen_kwargs["language"] = language
        gen_kwargs["task"]     = "transcribe"

    result = pipe(audio, generate_kwargs=gen_kwargs)

    if progress_cb:
        progress_cb(83)

    full_text   = (result.get("text") or "").strip()
    # Use `or []` — get() only returns the default when the key is absent,
    # but the pipeline may return chunks=None explicitly.
    raw_chunks  = result.get("chunks") or []
    segments: list[dict] = []

    if raw_chunks:
        for chunk in raw_chunks:
            ts    = chunk.get("timestamp") or (0.0, 0.0)
            start = float(ts[0]) if ts[0] is not None else 0.0
            end   = float(ts[1]) if ts[1] is not None else start
            text  = chunk.get("text", "").strip()
            segments.append({"start": start, "end": end, "text": text})
            duration = max(duration, end)
    else:
        segments = [{"start": 0.0, "end": duration, "text": full_text}]

    return {
        "text":     full_text,
        "segments": segments,
        "words":    [],
        "duration": duration,
        "language": language,
    }
