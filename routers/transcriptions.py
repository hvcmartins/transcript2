import asyncio
import json
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile

from services.database import (
    create_transcription,
    delete_transcription,
    get_all_transcriptions,
    get_transcription,
    update_transcription,
)
from services.groq_service import SUPPORTED_LANGUAGES, SUPPORTED_MODELS, transcribe_file, preprocess_audio
from services.local_transcription import SUPPORTED_LOCAL_MODELS, transcribe_locally, is_model_cached
from services.whisper_openvino import (
    OPENVINO_AVAILABLE, SUPPORTED_OV_MODELS, transcribe_openvino, is_ov_model_cached,
)

router = APIRouter()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_SIZE = 25 * 1024 * 1024  # 25 MB

ALLOWED_EXTENSIONS = {
    ".mp3", ".mp4", ".m4a", ".wav", ".webm", ".ogg", ".flac",
    ".aac", ".opus", ".mpeg", ".mpga", ".3gp", ".mov", ".avi",
    ".mkv", ".wmv",
}


# ── Meta ──────────────────────────────────────────────────────────────────────
@router.get("/meta")
async def get_meta():
    local_models_with_cache = [
        {**m, "cached": is_model_cached(m["id"])}
        for m in SUPPORTED_LOCAL_MODELS
    ]
    ov_models_with_cache = [
        {**m, "cached": is_ov_model_cached(m["id"])}
        for m in SUPPORTED_OV_MODELS
    ]
    return {
        "models":        SUPPORTED_MODELS,
        "languages":     SUPPORTED_LANGUAGES,
        "local_models":  local_models_with_cache,
        "ov_models":     ov_models_with_cache,
        "ov_available":  OPENVINO_AVAILABLE,
    }


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("")
async def list_transcriptions():
    return get_all_transcriptions()


# ── Get one ───────────────────────────────────────────────────────────────────
@router.get("/{id}")
async def get_one(id: str):
    item = get_transcription(id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    if item.get("segments"):
        item["segments"] = json.loads(item["segments"])
    if item.get("words"):
        item["words"] = json.loads(item["words"])
    return item


# ── Upload + transcribe ───────────────────────────────────────────────────────
@router.post("", status_code=202)
async def create(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    language: str    = Form("auto"),
    model: str       = Form("whisper-large-v3-turbo"),
    source: str      = Form("groq"),   # "groq" | "local" | "auto" | "openvino"
    local_model: str = Form("small"),
    ov_model: str    = Form("small"),
):
    suffix = Path(file.filename or "").suffix.lower() or ".audio"
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    # Stream upload to disk (250 MB hard ceiling — preprocessing will compress it)
    UPLOAD_LIMIT = 250 * 1024 * 1024
    filename = f"{uuid.uuid4().hex}{suffix}"
    file_path = UPLOAD_DIR / filename
    size = 0

    with open(file_path, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > UPLOAD_LIMIT:
                out.close()
                file_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="File too large (max 250 MB upload)")
            out.write(chunk)

    # Persist record
    record_id = str(uuid.uuid4())
    record = create_transcription({
        "id":            record_id,
        "filename":      filename,
        "original_name": file.filename,
        "file_size":     size,
        "language":      language,
        "model":         model,
    })

    # Kick off background transcription
    manager = request.app.state.manager
    background_tasks.add_task(
        _run_transcription, record_id, str(file_path),
        language, model, manager, source, local_model, ov_model
    )

    return record


# ── Delete ────────────────────────────────────────────────────────────────────
@router.delete("/{id}")
async def delete(id: str):
    item = get_transcription(id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")

    (UPLOAD_DIR / item["filename"]).unlink(missing_ok=True)
    delete_transcription(id)
    return {"success": True}


# ── Background worker ─────────────────────────────────────────────────────────
async def _run_transcription(
    id: str, file_path: str, language: str, model: str, manager,
    source: str = "groq", local_model: str = "small", ov_model: str = "small",
) -> None:
    """
    Orchestrates preprocessing → transcription (Groq / local / auto) →
    diarization, broadcasting WebSocket progress throughout.
    """

    async def _send(pct: int, msg_type: str = "progress", extra: dict | None = None):
        payload = {"type": msg_type, "id": id, "status": "processing", "progress": pct}
        if extra:
            payload.update(extra)
        update_transcription(id, {"progress": pct})
        await manager.broadcast(id, payload)

    await _send(5)

    processed_path: str | None = None
    is_temp = False

    try:
        # ── Step 1: preprocess (strip video, 16 kHz mono MP3) ─────────────────
        await _send(10, extra={"label": "Preprocessing audio…"})
        processed_path, is_temp = await asyncio.to_thread(preprocess_audio, file_path)

        # ── Step 2: transcribe ────────────────────────────────────────────────
        result: dict | None = None

        # Groq attempt
        if source in ("groq", "auto"):
            try:
                await _send(30, extra={"label": "Transcribing with Groq…"})
                result = await asyncio.to_thread(
                    transcribe_file, processed_path, language, model
                )
            except Exception as groq_exc:
                if source == "groq":
                    raise                   # hard failure — propagate
                # "auto" mode: log and fall through to local
                print(f"Groq failed for [{id}], falling back to local: {groq_exc}")
                await _send(30, extra={"label": "Groq unavailable — switching to local CPU…"})

        # Local attempt (source=="local" or Groq failed in "auto" mode)
        if result is None and source in ("local", "auto"):
            # First run downloads the model (~466 MB for small) — warn the user
            from services.local_transcription import is_model_cached
            if not is_model_cached(local_model):
                await _send(28, extra={"label": f"Downloading {local_model} model (first time)…"})

            await _send(30, extra={"label": f"Transcribing locally ({local_model})…"})

            # Thread-safe progress bridge: local transcription calls this from
            # the worker thread; we schedule the coroutine on the event loop.
            loop = asyncio.get_event_loop()

            def _local_progress(pct: int):
                asyncio.run_coroutine_threadsafe(
                    _send(pct, extra={"label": f"Transcribing locally ({local_model})…"}),
                    loop,
                )

            result = await asyncio.to_thread(
                transcribe_locally, processed_path, language, local_model, _local_progress
            )

        # OpenVINO attempt (source=="openvino" only — no auto-fallback)
        if source == "openvino":
            if not is_ov_model_cached(ov_model):
                await _send(28, extra={"label": f"Downloading OpenVINO {ov_model} model (first time)…"})
            ov_device = os.getenv("OPENVINO_DEVICE", "GPU")
            await _send(30, extra={"label": f"Transcribing with OpenVINO ({ov_model}) on {ov_device}…"})

            loop = asyncio.get_event_loop()

            def _ov_progress(pct: int):
                asyncio.run_coroutine_threadsafe(
                    _send(pct, extra={"label": f"Transcribing with OpenVINO ({ov_model})…"}),
                    loop,
                )

            result = await asyncio.to_thread(
                transcribe_openvino, processed_path, language, ov_model, _ov_progress
            )

        # ── Step 3: speaker diarization ───────────────────────────────────────
        await _send(80, extra={"label": "Analysing speakers…"})

        segments = result["segments"]
        try:
            from services.diarization import diarize, DIARIZATION_ENABLED
            if DIARIZATION_ENABLED and segments:
                segments = await asyncio.to_thread(diarize, file_path, segments)
        except Exception as diar_exc:
            print(f"Diarization skipped [{id}]: {diar_exc}")

        # ── Step 4: persist ───────────────────────────────────────────────────
        await _send(90, extra={"label": "Saving…"})

        update_transcription(id, {
            "status":     "completed",
            "progress":   100,
            "transcript": result["text"],
            "segments":   json.dumps(segments),
            "words":      json.dumps(result["words"]),
            "duration":   result["duration"],
        })

        await manager.broadcast(id, {
            "type":       "complete",
            "id":         id,
            "status":     "completed",
            "progress":   100,
            "transcript": result["text"],
            "segments":   segments,
            "words":      result["words"],
            "duration":   result["duration"],
            "language":   result["language"],
        })

    except Exception as exc:
        import traceback
        print(f"Transcription error [{id}]: {exc}\n{traceback.format_exc()}")
        update_transcription(id, {"status": "failed", "error_msg": str(exc)})
        await manager.broadcast(id, {
            "type":   "error",
            "id":     id,
            "status": "failed",
            "error":  str(exc),
        })
    finally:
        if is_temp and processed_path and os.path.exists(processed_path):
            os.unlink(processed_path)
