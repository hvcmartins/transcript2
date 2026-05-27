import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import transcriptionsRouter from './routes/transcriptions.js';
import exportsRouter from './routes/exports.js';
import { initDatabase } from './services/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure upload directory exists
const uploadDir = process.env.UPLOAD_DIR || join(__dirname, 'uploads');
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Store connected clients keyed by sessionId
const clients = new Map();

wss.on('connection', (ws) => {
  const registeredIds = new Set();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'register') {
        registeredIds.add(msg.sessionId);
        clients.set(msg.sessionId, ws);
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => {
    registeredIds.forEach(id => clients.delete(id));
  });
});

// Attach WebSocket broadcaster to app so routes can use it
app.locals.broadcast = (sessionId, payload) => {
  const ws = clients.get(sessionId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
};

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.use('/api/transcriptions', transcriptionsRouter);
app.use('/api/exports', exportsRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'rdtlTranscript', version: '1.0.0' });
});

const PORT = process.env.PORT || 6133;
const HOST = process.env.HOST || '0.0.0.0';

initDatabase();

server.listen(PORT, HOST, () => {
  console.log(`📝  rdtlTranscript running at http://${HOST}:${PORT}`);
});
