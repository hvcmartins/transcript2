import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from routers import transcriptions, exports
from services.database import init_database

# ── Directories ──────────────────────────────────────────────────────────────
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ── WebSocket connection manager ─────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self._connections: dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()

    def register(self, session_id: str, websocket: WebSocket):
        self._connections[session_id] = websocket

    def unregister(self, session_id: str):
        self._connections.pop(session_id, None)

    async def broadcast(self, session_id: str, payload: dict):
        ws = self._connections.get(session_id)
        if ws:
            try:
                await ws.send_json(payload)
            except Exception:
                self.unregister(session_id)


manager = ConnectionManager()


# ── App lifecycle ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_database()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.state.manager = manager


# ── WebSocket endpoint ────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    registered: set[str] = set()
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                if msg.get("type") == "register":
                    sid = msg.get("sessionId")
                    if sid:
                        manager.register(sid, websocket)
                        registered.add(sid)
            except Exception:
                pass
    except WebSocketDisconnect:
        for sid in registered:
            manager.unregister(sid)


# ── API routes ────────────────────────────────────────────────────────────────
app.include_router(transcriptions.router, prefix="/api/transcriptions")
app.include_router(exports.router,        prefix="/api/exports")


@app.get("/api/health")
async def health():
    return {"status": "ok", "app": "rdtlTranscript", "version": "1.0.0"}


# ── Static frontend (must come last) ─────────────────────────────────────────
# Single mount at "/" with html=True:
#   - serves actual files (js, css) when they exist in public/
#   - falls back to index.html for any unknown path (SPA behaviour)
# All /api/* and /ws routes above take priority because they were added first.
app.mount("/", StaticFiles(directory="public", html=True), name="static")
