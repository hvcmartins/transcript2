import { Router } from 'express';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { upload } from '../middleware/upload.js';
import { transcribeFile, SUPPORTED_MODELS, SUPPORTED_LANGUAGES } from '../services/groq.js';
import {
  createTranscription,
  getTranscription,
  getAllTranscriptions,
  updateTranscription,
  deleteTranscription,
} from '../services/database.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', 'uploads');

// GET /api/transcriptions/meta  — models + languages
router.get('/meta', (_req, res) => {
  res.json({ models: SUPPORTED_MODELS, languages: SUPPORTED_LANGUAGES });
});

// GET /api/transcriptions
router.get('/', (_req, res) => {
  res.json(getAllTranscriptions());
});

// GET /api/transcriptions/:id
router.get('/:id', (req, res) => {
  const item = getTranscription(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  // Parse JSON fields
  if (item.segments) item.segments = JSON.parse(item.segments);
  if (item.words) item.words = JSON.parse(item.words);

  res.json(item);
});

// POST /api/transcriptions  — upload + start transcription
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { language = 'auto', model = 'whisper-large-v3-turbo' } = req.body;

  const id = uuidv4();
  const record = createTranscription({
    id,
    filename: req.file.filename,
    originalName: req.file.originalname,
    fileSize: req.file.size,
    language,
    model,
  });

  res.status(202).json(record);

  // Run transcription in background
  const broadcast = req.app.locals.broadcast;

  setImmediate(async () => {
    const filePath = join(UPLOAD_DIR, req.file.filename);

    try {
      updateTranscription(id, { status: 'processing', progress: 5 });
      broadcast(id, { type: 'progress', id, status: 'processing', progress: 5 });

      const result = await transcribeFile(filePath, {
        language,
        model,
        onProgress: (pct) => {
          updateTranscription(id, { progress: pct });
          broadcast(id, { type: 'progress', id, status: 'processing', progress: pct });
        },
      });

      updateTranscription(id, {
        status: 'completed',
        progress: 100,
        transcript: result.text,
        segments: JSON.stringify(result.segments),
        words: JSON.stringify(result.words),
        duration: result.duration,
      });

      broadcast(id, {
        type: 'complete',
        id,
        status: 'completed',
        progress: 100,
        transcript: result.text,
        segments: result.segments,
        words: result.words,
        duration: result.duration,
        language: result.language,
      });
    } catch (err) {
      console.error('Transcription error:', err.message);
      updateTranscription(id, { status: 'failed', error_msg: err.message });
      broadcast(id, { type: 'error', id, status: 'failed', error: err.message });
    }
  });
});

// DELETE /api/transcriptions/:id
router.delete('/:id', async (req, res) => {
  const item = getTranscription(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  // Delete uploaded file
  const filePath = join(UPLOAD_DIR, item.filename);
  if (existsSync(filePath)) {
    await unlink(filePath).catch(() => {});
  }

  deleteTranscription(req.params.id);
  res.json({ success: true });
});

export default router;
