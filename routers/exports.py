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


def _mmss(secs: float) -> str:
    """Short MM:SS timestamp for human-readable text exports."""
    m = int(secs // 60)
    s = int(secs % 60)
    return f"{m:02d}:{s:02d}"


def _spk_prefix(seg: dict, prev_speaker: list) -> str:
    """Return '[Speaker X] ' prefix when speaker changes (or first segment)."""
    spk = seg.get("speaker")
    if not spk:
        return ""
    prefix = f"[{spk}] " if spk != prev_speaker[0] else ""
    prev_speaker[0] = spk
    return prefix


def _txt_plain(item: dict) -> str:
    return item["transcript"] or ""


def _txt_ts(segments: list) -> str:
    """Timestamped plain-text: [MM:SS] [Speaker X] text"""
    lines = []
    prev = [None]
    for seg in segments:
        ts   = _mmss(seg.get("start", 0))
        spk  = _spk_prefix(seg, prev)
        text = seg.get("text", "").strip()
        lines.append(f"[{ts}] {spk}{text}")
    return "\n".join(lines)


def _srt(segments: list) -> str:
    parts = []
    prev = [None]
    for i, seg in enumerate(segments, 1):
        spk  = _spk_prefix(seg, prev)
        text = f"{spk}{seg['text'].strip()}"
        parts.append(
            f"{i}\n{_ts(seg['start'])} --> {_ts(seg['end'])}\n{text}\n"
        )
    return "\n".join(parts)


def _vtt(segments: list) -> str:
    lines = ["WEBVTT", ""]
    prev = [None]
    for i, seg in enumerate(segments, 1):
        spk = seg.get("speaker")
        text = seg["text"].strip()
        time_line = f"{_ts(seg['start'], '.')} --> {_ts(seg['end'], '.')}"
        if spk:
            # WebVTT voice span — compatible with most players
            text_line = f"<v {spk}>{text}"
        else:
            text_line = text
        lines += [str(i), time_line, text_line, ""]
    return "\n".join(lines)


def _tsv(segments: list) -> str:
    has_speakers = any(seg.get("speaker") for seg in segments)
    if has_speakers:
        rows = ["start\tend\tspeaker\ttext"]
        for seg in segments:
            rows.append(
                f"{seg['start']:.3f}\t{seg['end']:.3f}\t"
                f"{seg.get('speaker', '')}\t{seg['text'].strip()}"
            )
    else:
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
            content, mime, ext = _txt_plain(item), "text/plain", "txt"
        case "txt-ts":
            content, mime, ext = _txt_ts(segments), "text/plain", "txt"
            base = base + "_timestamped"
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
