"""
SQLite persistence via Python's built-in sqlite3 — no native compilation needed.
"""
import sqlite3
import os
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "rdtlTranscript.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Module-level connection (thread-safe with WAL + check_same_thread=False)
_db: sqlite3.Connection | None = None


def _get_db() -> sqlite3.Connection:
    global _db
    if _db is None:
        _db = _connect()
    return _db


def init_database() -> None:
    db = _get_db()
    db.execute("""
        CREATE TABLE IF NOT EXISTS transcriptions (
            id            TEXT PRIMARY KEY,
            filename      TEXT NOT NULL,
            original_name TEXT NOT NULL,
            file_size     INTEGER NOT NULL,
            duration      REAL,
            language      TEXT,
            status        TEXT NOT NULL DEFAULT 'pending',
            progress      INTEGER NOT NULL DEFAULT 0,
            transcript    TEXT,
            segments      TEXT,
            words         TEXT,
            error_msg     TEXT,
            model         TEXT DEFAULT 'whisper-large-v3-turbo',
            created_at    TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    db.commit()
    print(f"📦 Database ready at {DB_PATH}")


def _row(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row else None


def create_transcription(data: dict) -> dict:
    db = _get_db()
    db.execute(
        """INSERT INTO transcriptions
               (id, filename, original_name, file_size, language, model, status)
           VALUES (:id, :filename, :original_name, :file_size, :language, :model, 'pending')""",
        data,
    )
    db.commit()
    return get_transcription(data["id"])


def get_transcription(id: str) -> dict | None:
    row = _get_db().execute(
        "SELECT * FROM transcriptions WHERE id = ?", (id,)
    ).fetchone()
    return _row(row)


def get_all_transcriptions(q: str | None = None) -> list[dict]:
    if q:
        like = f'%{q}%'
        rows = _get_db().execute(
            """SELECT id, filename, original_name, file_size, duration, language,
                      status, progress, error_msg, model, created_at, updated_at,
                      CASE WHEN lower(transcript) LIKE lower(:like)
                           THEN substr(transcript, max(1, instr(lower(transcript), lower(:q)) - 40), 160)
                           ELSE NULL END as snippet
               FROM transcriptions
               WHERE lower(original_name) LIKE lower(:like) OR lower(transcript) LIKE lower(:like)
               ORDER BY created_at DESC""",
            {"like": like, "q": q},
        ).fetchall()
    else:
        rows = _get_db().execute(
            """SELECT id, filename, original_name, file_size, duration, language,
                      status, progress, error_msg, model, created_at, updated_at
               FROM transcriptions ORDER BY created_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def update_transcription(id: str, fields: dict) -> None:
    allowed = {"status", "progress", "transcript", "segments", "words", "duration", "error_msg", "original_name"}
    filtered = {k: v for k, v in fields.items() if k in allowed}
    if not filtered:
        return
    set_clause = ", ".join(f"{k} = :{k}" for k in filtered)
    filtered["id"] = id
    db = _get_db()
    db.execute(
        f"UPDATE transcriptions SET {set_clause}, updated_at = datetime('now') WHERE id = :id",
        filtered,
    )
    db.commit()


def delete_transcription(id: str) -> None:
    db = _get_db()
    db.execute("DELETE FROM transcriptions WHERE id = ?", (id,))
    db.commit()
