// ─── UUID helper (works on HTTP, not just HTTPS) ─────────────────────────────
function generateUUID() {
  try { return crypto.randomUUID(); } catch (_) {}
  // Fallback for non-secure contexts (plain HTTP on local network)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  currentView: 'upload',
  selectedFile: null,
  currentTranscriptionId: null,
  ws: null,
  sessionId: generateUUID(),
  history: [],
};

// ─── DOM Refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  // Nav
  navBtns: document.querySelectorAll('.nav-btn'),
  views: { upload: $('uploadView'), history: $('historyView'), transcript: $('transcriptView') },
  // Upload
  dropZone: $('dropZone'),
  fileInput: $('fileInput'),
  browseBtn: $('browseBtn'),
  optionsPanel: $('optionsPanel'),
  selectedFileName: $('selectedFileName'),
  selectedFileSize: $('selectedFileSize'),
  clearFile: $('clearFile'),
  languageSelect: $('languageSelect'),
  modelSelect: $('modelSelect'),
  transcribeBtn: $('transcribeBtn'),
  progressPanel: $('progressPanel'),
  progressLabel: $('progressLabel'),
  progressBar: $('progressBar'),
  progressFilename: $('progressFilename'),
  // Transcript
  backBtn: $('backBtn'),
  metaFilename: $('metaFilename'),
  metaDuration: $('metaDuration'),
  metaLanguage: $('metaLanguage'),
  exportBtn: $('exportBtn'),
  exportMenu: $('exportMenu'),
  copyBtn: $('copyBtn'),
  segmentView: $('segmentView'),
  // History
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  // Status
  apiStatus: $('apiStatus'),
  toastContainer: $('toastContainer'),
};

// ─── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'register', sessionId: state.sessionId }));
    setStatus(true);
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  });

  ws.addEventListener('close', () => {
    setStatus(false);
    setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => setStatus(false));
  state.ws = ws;
}

function setStatus(ok) {
  const dot = el.apiStatus.querySelector('.status-dot');
  const txt = el.apiStatus.querySelector('.status-text');
  dot.className = 'status-dot' + (ok ? '' : ' error');
  txt.textContent = ok ? 'Connected' : 'Reconnecting…';
}

function handleWsMessage(msg) {
  if (msg.type === 'progress') {
    updateProgress(msg.progress, 'Transcribing…');
  } else if (msg.type === 'complete') {
    updateProgress(100, 'Done!');
    setTimeout(() => {
      el.progressPanel.hidden = true;
      showToast('Transcription complete!', 'success');
      loadTranscription(msg.id);
    }, 600);
    refreshHistory();
  } else if (msg.type === 'error') {
    el.progressPanel.hidden = true;
    el.optionsPanel.hidden = false;
    showToast(`Error: ${msg.error}`, 'error');
    refreshHistory();
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function showView(name) {
  state.currentView = name;
  Object.values(el.views).forEach(v => v.classList.remove('active'));
  el.navBtns.forEach(b => b.classList.remove('active'));

  if (name === 'transcript') {
    el.views.transcript.classList.add('active');
  } else {
    el.views[name]?.classList.add('active');
    document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add('active');
  }

  if (name === 'history') refreshHistory();
}

el.navBtns.forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ─── File Selection ──────────────────────────────────────────────────────────
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const vid = ['mp4','mkv','mov','avi','webm','flv','wmv'];
  return vid.includes(ext) ? '🎬' : '🎵';
}

function setSelectedFile(file) {
  if (!file) {
    state.selectedFile = null;
    el.optionsPanel.hidden = true;
    return;
  }
  state.selectedFile = file;
  el.selectedFileName.textContent = file.name;
  el.selectedFileSize.textContent = formatBytes(file.size);
  el.optionsPanel.querySelector('.file-icon').textContent = getFileIcon(file.name);
  el.optionsPanel.hidden = false;
}

el.browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.click();
});

el.dropZone.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files[0]) setSelectedFile(el.fileInput.files[0]);
});

el.clearFile.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.value = '';
  setSelectedFile(null);
});

// Drag & Drop
el.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropZone.classList.add('drag-over');
});

el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));

el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

// ─── Upload & Transcribe ──────────────────────────────────────────────────────
el.transcribeBtn.addEventListener('click', async () => {
  if (!state.selectedFile) return;

  const formData = new FormData();
  formData.append('file', state.selectedFile);
  formData.append('language', el.languageSelect.value);
  formData.append('model', el.modelSelect.value);

  el.optionsPanel.hidden = true;
  el.progressPanel.hidden = false;
  el.progressFilename.textContent = state.selectedFile.name;
  updateProgress(2, 'Uploading…');

  try {
    const res = await fetch('/api/transcriptions', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Upload failed');
    }
    const data = await res.json();
    state.currentTranscriptionId = data.id;
    updateProgress(8, 'Waiting for Groq…');

    // Subscribe to this transcription's WS events
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'register', sessionId: data.id }));
      // Re-register own session too so broadcast works
      state.ws.send(JSON.stringify({ type: 'register', sessionId: state.sessionId }));
    }
  } catch (err) {
    el.progressPanel.hidden = true;
    el.optionsPanel.hidden = false;
    showToast(err.message, 'error');
  }
});

function updateProgress(pct, label) {
  el.progressBar.style.width = pct + '%';
  if (label) el.progressLabel.textContent = label;
}

// ─── Transcript Display ───────────────────────────────────────────────────────
function secondsToMMSS(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function loadTranscription(id) {
  try {
    const res = await fetch(`/api/transcriptions/${id}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();

    el.metaFilename.textContent = data.original_name;
    el.metaDuration.textContent = data.duration ? `⏱ ${secondsToMMSS(data.duration)}` : '';
    el.metaLanguage.textContent = data.language && data.language !== 'auto' ? `🌐 ${data.language.toUpperCase()}` : '';

    el.segmentView.innerHTML = '';

    const segments = data.segments || [];
    if (segments.length > 0) {
      segments.forEach(seg => {
        const div = document.createElement('div');
        div.className = 'segment';
        div.innerHTML = `
          <span class="seg-time">${secondsToMMSS(seg.start)}</span>
          <span class="seg-text">${escapeHtml(seg.text.trim())}</span>
        `;
        el.segmentView.appendChild(div);
      });
    } else if (data.transcript) {
      const div = document.createElement('div');
      div.className = 'segment';
      div.innerHTML = `<span class="seg-time">00:00</span><span class="seg-text">${escapeHtml(data.transcript)}</span>`;
      el.segmentView.appendChild(div);
    }

    // Store current id for exports
    state.currentTranscriptionId = id;
    showView('transcript');

    // Reset upload state
    el.fileInput.value = '';
    setSelectedFile(null);
    el.progressPanel.hidden = true;
  } catch (err) {
    showToast('Failed to load transcription', 'error');
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Export ───────────────────────────────────────────────────────────────────
el.exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  el.exportMenu.classList.toggle('open');
});

document.addEventListener('click', () => el.exportMenu.classList.remove('open'));

el.exportMenu.querySelectorAll('.dropdown-item').forEach(item => {
  item.addEventListener('click', () => {
    const fmt = item.dataset.format;
    const id = state.currentTranscriptionId;
    if (id) {
      window.open(`/api/exports/${id}/${fmt}`, '_blank');
    }
    el.exportMenu.classList.remove('open');
  });
});

el.copyBtn.addEventListener('click', async () => {
  const texts = [...el.segmentView.querySelectorAll('.seg-text')].map(e => e.textContent).join('\n');
  try {
    // clipboard API requires HTTPS; fall back to execCommand on plain HTTP
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texts);
    } else {
      const ta = document.createElement('textarea');
      ta.value = texts;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Copied to clipboard!', 'success');
  } catch (_) {
    showToast('Copy failed — try selecting the text manually', 'error');
  }
});

// ─── Back Button ─────────────────────────────────────────────────────────────
el.backBtn.addEventListener('click', () => showView('upload'));

// ─── History ─────────────────────────────────────────────────────────────────
async function refreshHistory() {
  try {
    const res = await fetch('/api/transcriptions');
    const items = await res.json();
    state.history = items;
    renderHistory(items);
  } catch { /* ignore */ }
}

function renderHistory(items) {
  el.historyList.innerHTML = '';

  if (!items.length) {
    el.historyList.appendChild(el.historyEmpty);
    el.historyEmpty.hidden = false;
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-icon">${getFileIcon(item.original_name)}</div>
      <div class="history-info">
        <div class="history-name">${escapeHtml(item.original_name)}</div>
        <div class="history-sub">
          <span>${formatBytes(item.file_size)}</span>
          ${item.duration ? `<span>⏱ ${secondsToMMSS(item.duration)}</span>` : ''}
          <span>${new Date(item.created_at).toLocaleDateString()}</span>
        </div>
      </div>
      <span class="history-badge badge-${item.status}">${item.status}</span>
      <button class="history-delete" data-id="${item.id}" title="Delete">🗑</button>
    `;

    if (item.status === 'completed') {
      div.style.cursor = 'pointer';
      div.querySelector('.history-info').addEventListener('click', () => loadTranscription(item.id));
      div.querySelector('.history-icon').addEventListener('click', () => loadTranscription(item.id));
    }

    div.querySelector('.history-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this transcription?')) return;
      await fetch(`/api/transcriptions/${item.id}`, { method: 'DELETE' });
      showToast('Deleted', 'info');
      refreshHistory();
    });

    el.historyList.appendChild(div);
  });
}

// ─── Load Metadata (languages + models) ──────────────────────────────────────
async function loadMeta() {
  try {
    const res = await fetch('/api/transcriptions/meta');
    const { models, languages } = await res.json();

    el.languageSelect.innerHTML = languages.map(l =>
      `<option value="${l.code}">${l.label}</option>`
    ).join('');

    el.modelSelect.innerHTML = models.map(m =>
      `<option value="${m.id}">${m.label}</option>`
    ).join('');
  } catch { /* use defaults */ }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── WS routing — map upload sessionId to transcription progress ─────────────
// The backend broadcasts using the transcription ID; we need to listen on
// the transcription ID. We re-register the WS with the transcription ID
// once it's created (done in transcribeBtn handler above).
// But we also need a fallback: poll if the WS message is missed.

// ─── Init ─────────────────────────────────────────────────────────────────────
connectWS();
loadMeta();
