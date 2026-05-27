import Groq from 'groq-sdk';
import { createReadStream, statSync } from 'fs';
import { basename } from 'path';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // Groq limit: 25 MB

let client;

function getClient() {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY environment variable is not set');
    client = new Groq({ apiKey });
  }
  return client;
}

/**
 * Transcribe an audio/video file using Groq Whisper.
 * @param {string} filePath - Absolute path to the file
 * @param {object} opts
 * @param {string} [opts.language] - ISO-639-1 language code or 'auto'
 * @param {string} [opts.model]    - Groq model to use
 * @param {Function} [opts.onProgress] - progress callback (0–100)
 * @returns {Promise<{text: string, segments: Array, words: Array, duration: number, language: string}>}
 */
export async function transcribeFile(filePath, opts = {}) {
  const groq = getClient();
  const { language = 'auto', model = 'whisper-large-v3-turbo', onProgress } = opts;

  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB. Max allowed is 25 MB.`);
  }

  if (onProgress) onProgress(10);

  const params = {
    file: createReadStream(filePath),
    model,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment', 'word'],
  };

  if (language && language !== 'auto') {
    params.language = language;
  }

  if (onProgress) onProgress(30);

  const response = await groq.audio.transcriptions.create(params);

  if (onProgress) onProgress(90);

  return {
    text: response.text || '',
    segments: response.segments || [],
    words: response.words || [],
    duration: response.duration || 0,
    language: response.language || language,
  };
}

export const SUPPORTED_MODELS = [
  { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (fast)' },
  { id: 'whisper-large-v3', label: 'Whisper Large v3 (accurate)' },
  { id: 'distil-whisper-large-v3-en', label: 'Distil Whisper (English only, fastest)' },
];

export const SUPPORTED_LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'fi', label: 'Finnish' },
  { code: 'nb', label: 'Norwegian' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
];
