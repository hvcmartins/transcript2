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
from services.groq_service import SUPPORTED_LANGUAGES, SUPPORTED_MODELS, transcribe_file

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
    return {"models": SUPPORTED_MODELS, "languages": SUPPORTED_LANGUAGES}


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("/")
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
@router.post("/", status_code=202)
async def create(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model: str = Form("whisper-large-v3-turbo"),
):
    suffix = Path(file.filename or "").suffix.lower() or ".audio"
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    # Stream upload to disk
    filename = f"{uuid.uuid4().hex}{suffix}"
    file_path = UPLOAD_DIR / filename
    size = 0

    with open(file_path, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_FILE_SIZE:
                out.close()
                file_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="File too large (max 25 MB)")
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
        _run_transcription, record_id, str(file_path), language, model, manager
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
    id: str, file_path: str, language: str, model: str, manager
) -> None:
    """
    Runs the Groq API call in a thread pool (non-blocking) and broadcasts
    progress/completion over WebSocket.
    """

    async def _send(pct: int, msg_type: str = "progress", extra: dict | None = None):
        payload = {"type": msg_type, "id": id, "status": "processing", "progress": pct}
        if extra:
            payload.update(extra)
        update_transcription(id, {"progress": pct})
        await manager.broadcast(id, payload)

    await _send(5)

    try:
        # 30 % — about to call Groq
        await _send(30)

        # Run blocking SDK call in thread pool so the event loop stays free
        result: dict = await asyncio.to_thread(
            transcribe_file, file_path, language, model
        )

        # 90 % — storing result
        await _send(90)

        update_transcription(id, {
            "status":     "completed",
            "progress":   100,
            "transcript": result["text"],
            "segments":   json.dumps(result["segments"]),
            "words":      json.dumps(result["words"]),
            "duration":   result["duration"],
        })

        await manager.broadcast(id, {
            "type":       "complete",
            "id":         id,
            "status":     "completed",
            "progress":   100,
            "transcript": result["text"],
            "segments":   result["segments"],
            "words":      result["words"],
            "duration":   result["duration"],
            "language":   result["language"],
        })

    except Exception as exc:
        print(f"Transcription error [{id}]: {exc}")
        update_transcription(id, {"status": "failed", "error_msg": str(exc)})
        await manager.broadcast(id, {
            "type":   "error",
            "id":     id,
            "status": "failed",
            "error":  str(exc),
        })
