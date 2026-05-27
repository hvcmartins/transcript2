import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from services.database import get_transcription

router = APIRouter()


# ── Helpers ───────────────────────────────────────────────────────────────────
def _ts(secs: float, sep: str = ",") -> str:
    h  = int(secs // 3600)
    m  = int((secs % 3600) // 60)
    s  = int(secs % 60)
    ms = round((secs % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _srt(segments: list) -> str:
    parts = []
    for i, seg in enumerate(segments, 1):
        parts.append(
            f"{i}\n{_ts(seg['start'])} --> {_ts(seg['end'])}\n{seg['text'].strip()}\n"
        )
    return "\n".join(parts)


def _vtt(segments: list) -> str:
    lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments, 1):
        lines += [str(i), f"{_ts(seg['start'], '.')} --> {_ts(seg['end'], '.')}", seg["text"].strip(), ""]
    return "\n".join(lines)


def _tsv(segments: list) -> str:
    rows = ["start\tend\ttext"]
    for seg in segments:
        rows.append(f"{seg['start']:.3f}\t{seg['end']:.3f}\t{seg['text'].strip()}")
    return "\n".join(rows)


# ── Endpoint ──────────────────────────────────────────────────────────────────
@router.get("/{id}/{fmt}")
async def export_transcription(id: str, fmt: str):
    item = get_transcription(id)
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    if item["status"] != "completed":
        raise HTTPException(status_code=409, detail="Transcription not complete")

    segments = json.loads(item["segments"]) if item.get("segments") else []
    base     = Path(item["original_name"]).stem

    match fmt:
        case "txt":
            content, mime, ext = item["transcript"], "text/plain", "txt"
        case "srt":
            content, mime, ext = _srt(segments), "text/srt", "srt"
        case "vtt":
            content, mime, ext = _vtt(segments), "text/vtt", "vtt"
        case "tsv":
            content, mime, ext = _tsv(segments), "text/tab-separated-values", "tsv"
        case "json":
            content = json.dumps({
                "text":     item["transcript"],
                "language": item["language"],
                "duration": item["duration"],
                "segments": segments,
                "words":    json.loads(item["words"]) if item.get("words") else [],
            }, indent=2)
            mime, ext = "application/json", "json"
        case _:
            raise HTTPException(status_code=400, detail=f"Unknown format: {fmt}")

    return Response(
        content=content,
        media_type=f"{mime}; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{base}.{ext}"'},
    )
