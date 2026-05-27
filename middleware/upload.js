import multer from 'multer';
import { join, extname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', 'uploads');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIMETYPES = [
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/webm',
  'audio/ogg', 'audio/flac', 'audio/x-flac',
  'audio/aac', 'audio/opus',
  'video/mp4', 'video/mpeg', 'video/webm', 'video/ogg',
  'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv',
  'video/x-matroska', 'video/3gpp',
  // Fallback for browsers that send generic types
  'application/octet-stream',
];

const ALLOWED_EXTENSIONS = [
  '.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.flac',
  '.aac', '.opus', '.mpeg', '.mpga', '.3gp', '.mov', '.avi',
  '.mkv', '.wmv',
];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const ext = extname(file.originalname).toLowerCase() || '.audio';
    cb(null, `${timestamp}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const ext = extname(file.originalname).toLowerCase();
  const mimeOk = ALLOWED_MIMETYPES.includes(file.mimetype);
  const extOk = ALLOWED_EXTENSIONS.includes(ext);
  if (mimeOk || extOk) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${ext || file.mimetype}`));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB (Groq limit)
  },
});
