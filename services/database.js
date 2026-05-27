import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbDir = process.env.DATA_DIR || join(__dirname, '..', 'data');
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const dbPath = join(dbDir, 'rdtlTranscript.db');
let db;

export function initDatabase() {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id          TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size   INTEGER NOT NULL,
      duration    REAL,
      language    TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      progress    INTEGER NOT NULL DEFAULT 0,
      transcript  TEXT,
      segments    TEXT,
      words       TEXT,
      error_msg   TEXT,
      model       TEXT DEFAULT 'whisper-large-v3-turbo',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  console.log('📦 Database ready at', dbPath);
  return db;
}

export function getDb() {
  if (!db) initDatabase();
  return db;
}

export function createTranscription(data) {
  getDb().prepare(`
    INSERT INTO transcriptions (id, filename, original_name, file_size, language, model, status)
    VALUES (@id, @filename, @originalName, @fileSize, @language, @model, 'pending')
  `).run(data);
  return getTranscription(data.id);
}

export function getTranscription(id) {
  return getDb().prepare('SELECT * FROM transcriptions WHERE id = ?').get(id);
}

export function getAllTranscriptions() {
  return getDb().prepare(`
    SELECT id, filename, original_name, file_size, duration, language, status,
           progress, error_msg, model, created_at, updated_at
    FROM transcriptions ORDER BY created_at DESC
  `).all();
}

export function updateTranscription(id, fields) {
  const allowed = ['status', 'progress', 'transcript', 'segments', 'words', 'duration', 'error_msg'];
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k]) => `${k} = @${k}`)
    .join(', ');
  if (!updates) return;
  getDb().prepare(`
    UPDATE transcriptions SET ${updates}, updated_at = datetime('now') WHERE id = @id
  `).run({ ...fields, id });
}

export function deleteTranscription(id) {
  getDb().prepare('DELETE FROM transcriptions WHERE id = ?').run(id);
}
