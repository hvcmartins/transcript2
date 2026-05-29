import asyncio
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from services.database import (
    create_transcription,
    delete_transcription,
    get_all_transcriptions,
    get_transcription,
    update_transcription,
)
from services.groq_service import (
    SUPPORTED_LANGUAGES, SUPPORTED_MODELS,
    transcribe_file, preprocess_audio, get_audio_duration,
)
from services.whisper_openvino import (
    OPENVINO_AVAILABLE, SUPPORTED_OV_MODELS, transcribe_openvino, is_ov_model_cached,
)

router = APIRouter()

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024  # 2 GB

ALLOWED_EXTENSIONS = {
    ".mp3", ".mp4", ".m4a", ".wav", ".webm", ".ogg", ".flac",
    ".aac", ".opus", ".mpeg", ".mpga", ".3gp", ".mov", ".avi",
    ".mkv", ".wmv",
}


# ── Meta ──────────────────────────────────────────────────────────────────────
@router.get("/meta")
async def get_meta():
    ov_models_with_cache = [
        {**m, "cached": is_ov_model_cached(m["id"])}
        for m in SUPPORTED_OV_MODELS
    ]
    return {
        "models":       SUPPORTED_MODELS,
        "languages":    SUPPORTED_LANGUAGES,
        "ov_models":    ov_models_with_cache,
        "ov_available": OPENVINO_AVAILABLE,
    }


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("")
async def list_transcriptions(q: Optional[str] = None):
    return get_all_transcriptions(q)


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


# ── Edit transcript text ──────────────────────────────────────────────────────
@router.patch("/{id}")
async def edit_transcript(id: str, body: dict):
    if not get_transcription(id):
        raise HTTPException(status_code=404, detail="Not found")
    fields: dict = {}
    if "transcript" in body:
        fields["transcript"] = str(body["transcript"])
    if "segments" in body:
        fields["segments"] = json.dumps(body["segments"])
    if "original_name" in body:
        name = str(body["original_name"]).strip()
        if name:
            fields["original_name"] = name
    if "description" in body:
        fields["description"] = str(body["description"])
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    update_transcription(id, fields)
    return {"ok": True}


# ── Phase 1: Upload + preprocess (returns preprocess_id immediately) ──────────
@router.post("/preprocess", status_code=202)
async def upload_and_preprocess(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    suffix = Path(file.filename or "").suffix.lower() or ".audio"
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    preprocess_id = uuid.uuid4().hex
    raw_filename  = f"{preprocess_id}{suffix}"
    raw_path      = UPLOAD_DIR / raw_filename
    size = 0

    with open(raw_path, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > UPLOAD_LIMIT:
                out.close()
                raw_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="File too large (max 2 GB)")
            out.write(chunk)

    manager = request.app.state.manager
    background_tasks.add_task(
        _run_preprocess, preprocess_id, str(raw_path),
        file.filename or raw_filename, size, manager,
    )

    return {"preprocess_id": preprocess_id}


async def _run_preprocess(
    preprocess_id: str,
    raw_path: str,
    original_name: str,
    original_size: int,
    manager,
) -> None:
    """
    Background: preprocess the uploaded file → compressed MP3.
    Saves {preprocess_id}.mp3 + {preprocess_id}.json sidecar in UPLOAD_DIR.
    Broadcasts progress/done/error to WebSocket channel `preprocess_id`.
    """
    async def _send(phase_pct: int, label: str = "Preprocessing audio…"):
        await manager.broadcast(preprocess_id, {
            "type":         "preprocess_progress",
            "preprocess_id": preprocess_id,
            "phase_pct":    phase_pct,
            "label":        label,
        })

    loop = asyncio.get_event_loop()

    def _cb(pct: int):
        asyncio.run_coroutine_threadsafe(_send(pct), loop)

    await _send(0)
    try:
        processed_path, is_temp = await asyncio.to_thread(preprocess_audio, raw_path, _cb)

        # Move compressed file to permanent location; always delete raw upload
        perm_path = str(UPLOAD_DIR / f"{preprocess_id}.mp3")
        shutil.move(processed_path, perm_path)
        if os.path.realpath(raw_path) != os.path.realpath(perm_path):
            Path(raw_path).unlink(missing_ok=True)

        compressed_size = Path(perm_path).stat().st_size
        duration_s = await asyncio.to_thread(get_audio_duration, perm_path)

        sidecar = UPLOAD_DIR / f"{preprocess_id}.json"
        sidecar.write_text(json.dumps({
            "original_name":   original_name,
            "original_size":   original_size,
            "compressed_size": compressed_size,
            "duration_s":      duration_s,
        }))

        await manager.broadcast(preprocess_id, {
            "type":          "preprocess_done",
            "preprocess_id": preprocess_id,
            "duration_s":    duration_s,
            "original_name": original_name,
        })

    except Exception as exc:
        import traceback
        print(f"Preprocess error [{preprocess_id}]: {exc}\n{traceback.format_exc()}")
        Path(raw_path).unlink(missing_ok=True)
        Path(UPLOAD_DIR / f"{preprocess_id}.mp3").unlink(missing_ok=True)
        Path(UPLOAD_DIR / f"{preprocess_id}.json").unlink(missing_ok=True)
        await manager.broadcast(preprocess_id, {
            "type":          "preprocess_error",
            "preprocess_id": preprocess_id,
            "error":         str(exc),
        })


# ── Phase 2: Start transcription (uses preprocess_id, no re-upload) ───────────
@router.post("", status_code=202)
async def create(
    request: Request,
    background_tasks: BackgroundTasks,
    preprocess_id: str    = Form(...),
    language: str         = Form("auto"),
    model: str            = Form("whisper-large-v3-turbo"),
    source: str           = Form("groq"),   # "groq" | "openvino"
    ov_model: str         = Form("small"),
    custom_name: str      = Form(None),     # optional user-provided name override
    description: str      = Form(None),     # optional description
):
    sidecar    = UPLOAD_DIR / f"{preprocess_id}.json"
    audio_path = UPLOAD_DIR / f"{preprocess_id}.mp3"

    if not sidecar.exists() or not audio_path.exists():
        raise HTTPException(status_code=404, detail="Preprocessed file not found or expired")

    meta = json.loads(sidecar.read_text())
    sidecar.unlink(missing_ok=True)

    # Rename to a transcription-scoped filename
    tx_filename = uuid.uuid4().hex + ".mp3"
    tx_path     = UPLOAD_DIR / tx_filename
    shutil.move(str(audio_path), str(tx_path))

    record_id = str(uuid.uuid4())
    final_name = (custom_name or "").strip() or meta["original_name"]
    record = create_transcription({
        "id":            record_id,
        "filename":      tx_filename,
        "original_name": final_name,
        "file_size":     meta.get("compressed_size") or meta["original_size"],
        "language":      language,
        "model":         model,
        "description":   (description or "").strip(),
    })

    manager = request.app.state.manager
    background_tasks.add_task(
        _run_transcription, record_id, str(tx_path),
        language, model, manager, source, ov_model,
    )

    return record


# ── Stream audio ─────────────────────────────────────────────────────────────
@router.get("/{id}/audio")
async def get_audio(id: str):
    item = get_transcription(id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    path = UPLOAD_DIR / item["filename"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(str(path), media_type="audio/mpeg")


# ── Re-transcribe ─────────────────────────────────────────────────────────────
@router.post("/{id}/retranscribe", status_code=202)
async def retranscribe(id: str):
    item = get_transcription(id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    src = UPLOAD_DIR / item["filename"]
    if not src.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    preprocess_id = uuid.uuid4().hex
    shutil.copy2(str(src), str(UPLOAD_DIR / f"{preprocess_id}.mp3"))
    (UPLOAD_DIR / f"{preprocess_id}.json").write_text(json.dumps({
        "original_name":   item["original_name"],
        "original_size":   item["file_size"],
        "compressed_size": item["file_size"],
        "duration_s":      item.get("duration"),
    }))
    return {"preprocess_id": preprocess_id, "original_name": item["original_name"], "duration_s": item.get("duration")}


# ── Delete ────────────────────────────────────────────────────────────────────
@router.delete("/{id}")
async def delete(id: str):
    item = get_transcription(id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")

    (UPLOAD_DIR / item["filename"]).unlink(missing_ok=True)
    delete_transcription(id)
    return {"success": True}


# ── Background transcription worker ──────────────────────────────────────────
async def _run_transcription(
    id: str, file_path: str, language: str, model: str, manager,
    source: str = "groq", ov_model: str = "small",
) -> None:
    async def _send(pct: int, msg_type: str = "progress", extra: dict | None = None):
        payload = {"type": msg_type, "id": id, "status": "processing", "progress": pct}
        if extra:
            payload.update(extra)
        update_transcription(id, {"progress": pct})
        await manager.broadcast(id, payload)

    await _send(5)

    try:
        # ── Transcribe (file already preprocessed) ────────────────────────────
        result: dict | None = None

        if source == "groq":
            await _send(30, extra={"label": "Transcribing with Groq…"})
            loop = asyncio.get_event_loop()

            def _groq_cb(chunk_num: int, total: int):
                label = (
                    f"Transcribing with Groq… (chunk {chunk_num}/{total})"
                    if total > 1 else "Transcribing with Groq…"
                )
                pct = 30 + int((chunk_num - 1) / total * 50)
                asyncio.run_coroutine_threadsafe(
                    _send(pct, extra={"label": label}), loop
                )

            result = await asyncio.to_thread(
                transcribe_file, file_path, language, model, _groq_cb
            )

        elif source == "openvino":
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
                transcribe_openvino, file_path, language, ov_model, _ov_progress
            )

        else:
            raise ValueError(f"Unknown source: {source!r}")

        # ── Speaker diarization ───────────────────────────────────────────────
        await _send(80, extra={"label": "Analysing speakers…"})

        segments = result["segments"]
        try:
            from services.diarization import diarize, DIARIZATION_ENABLED
            if DIARIZATION_ENABLED and segments:
                segments = await asyncio.to_thread(diarize, file_path, segments)
        except Exception as diar_exc:
            print(f"Diarization skipped [{id}]: {diar_exc}")

        # ── Persist ───────────────────────────────────────────────────────────
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
