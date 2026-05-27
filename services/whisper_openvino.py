"""
Intel GPU transcription via OpenVINO GenAI.

Uses pre-converted Whisper INT8 models from HuggingFace (OpenVINO/* org).
Models are downloaded on first use and cached in MODELS_DIR/openvino/<id>/.

Requirements (installed separately from base image):
  pip install openvino-genai huggingface-hub

Environment variables:
  MODELS_DIR      — model cache root         (default: models)
  OPENVINO_DEVICE — "GPU" | "CPU" | "AUTO"   (default: GPU)
"""

import os
from pathlib import Path

MODELS_DIR      = Path(os.getenv("MODELS_DIR", "models"))
OPENVINO_DEVICE = os.getenv("OPENVINO_DEVICE", "GPU")

SUPPORTED_OV_MODELS = [
    {"id": "base",     "hf_id": "OpenVINO/whisper-base-int8-ov",     "label": "Base — ~100 MB · fast"},
    {"id": "small",    "hf_id": "OpenVINO/whisper-small-int8-ov",    "label": "Small — ~230 MB · balanced ✓"},
    {"id": "medium",   "hf_id": "OpenVINO/whisper-medium-int8-ov",   "label": "Medium — ~750 MB · accurate"},
    {"id": "large-v3", "hf_id": "OpenVINO/whisper-large-v3-int8-ov", "label": "Large v3 — ~1.5 GB · best"},
]

_pipeline_cache: dict = {}


def _hf_id(model_id: str) -> str:
    for m in SUPPORTED_OV_MODELS:
        if m["id"] == model_id:
            return m["hf_id"]
    return f"OpenVINO/whisper-{model_id}-int8-ov"


def _is_available() -> bool:
    try:
        import openvino_genai  # noqa: F401
        return True
    except ImportError:
        return False


OPENVINO_AVAILABLE = _is_available()


def is_ov_model_cached(model_id: str) -> bool:
    model_dir = MODELS_DIR / "openvino" / model_id
    return model_dir.exists() and any(model_dir.iterdir())


def _get_pipeline(model_id: str):
    global _pipeline_cache
    if model_id not in _pipeline_cache:
        import openvino_genai as ov_genai
        model_path = MODELS_DIR / "openvino" / model_id
        model_path.mkdir(parents=True, exist_ok=True)
        if not any(model_path.iterdir()):
            from huggingface_hub import snapshot_download
            snapshot_download(
                repo_id=_hf_id(model_id),
                local_dir=str(model_path),
            )
        _pipeline_cache[model_id] = ov_genai.WhisperPipeline(str(model_path), OPENVINO_DEVICE)
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
            "openvino-genai is not installed. "
            "Rebuild the image with --build-arg WITH_OPENVINO=true."
        )

    import librosa
    import openvino_genai as ov_genai

    if progress_cb:
        progress_cb(32)

    pipeline = _get_pipeline(model_id)

    # librosa normalises to [-1, 1] float32 at the requested sample rate
    audio, _ = librosa.load(file_path, sr=16000, mono=True)

    config = ov_genai.WhisperGenerationConfig()
    config.return_timestamps = True
    if language and language != "auto":
        config.language = f"<|{language}|>"

    if progress_cb:
        progress_cb(38)

    result = pipeline.generate(audio.tolist(), config)

    if progress_cb:
        progress_cb(83)

    full_text = result.texts[0] if result.texts else ""
    duration   = float(len(audio)) / 16000.0

    segments: list[dict] = []
    if hasattr(result, "chunks") and result.chunks:
        for chunk in result.chunks:
            start = float(getattr(chunk, "start_ts", 0.0) or 0.0)
            end   = float(getattr(chunk, "end_ts",   0.0) or 0.0)
            text  = str(getattr(chunk, "text", ""))
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
