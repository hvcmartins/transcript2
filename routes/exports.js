import { Router } from 'express';
import { getTranscription } from '../services/database.js';

const router = Router();

function secondsToTimestamp(secs, separator = ',') {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
}

function buildSrt(segments) {
  return segments.map((seg, i) => (
    `${i + 1}\n${secondsToTimestamp(seg.start)} --> ${secondsToTimestamp(seg.end)}\n${seg.text.trim()}\n`
  )).join('\n');
}

function buildVtt(segments) {
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, i) => {
    lines.push(`${i + 1}`);
    lines.push(`${secondsToTimestamp(seg.start, '.')} --> ${secondsToTimestamp(seg.end, '.')}`);
    lines.push(seg.text.trim());
    lines.push('');
  });
  return lines.join('\n');
}

function buildTxt(transcript) {
  return transcript;
}

function buildTsv(segments) {
  const rows = [['start', 'end', 'text'].join('\t')];
  segments.forEach(seg => {
    rows.push([seg.start.toFixed(3), seg.end.toFixed(3), seg.text.trim()].join('\t'));
  });
  return rows.join('\n');
}

// GET /api/exports/:id/:format
router.get('/:id/:format', (req, res) => {
  const { id, format } = req.params;
  const item = getTranscription(id);

  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.status !== 'completed') return res.status(409).json({ error: 'Transcription not complete' });

  const segments = item.segments ? JSON.parse(item.segments) : [];
  const baseName = item.original_name.replace(/\.[^/.]+$/, '');

  let content, mimeType, ext;

  switch (format) {
    case 'txt':
      content = buildTxt(item.transcript);
      mimeType = 'text/plain';
      ext = 'txt';
      break;
    case 'srt':
      content = buildSrt(segments);
      mimeType = 'text/srt';
      ext = 'srt';
      break;
    case 'vtt':
      content = buildVtt(segments);
      mimeType = 'text/vtt';
      ext = 'vtt';
      break;
    case 'tsv':
      content = buildTsv(segments);
      mimeType = 'text/tab-separated-values';
      ext = 'tsv';
      break;
    case 'json':
      content = JSON.stringify({
        text: item.transcript,
        language: item.language,
        duration: item.duration,
        segments,
        words: item.words ? JSON.parse(item.words) : [],
      }, null, 2);
      mimeType = 'application/json';
      ext = 'json';
      break;
    default:
      return res.status(400).json({ error: `Unknown format: ${format}` });
  }

  res.setHeader('Content-Type', `${mimeType}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.${ext}"`);
  res.send(content);
});

export default router;
