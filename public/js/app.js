// ─── UUID helper (works on HTTP, not just HTTPS) ─────────────────────────────
function generateUUID() {
  try { return crypto.randomUUID(); } catch (_) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  currentView: 'upload',
  selectedFile: null,
  currentTranscriptionId: null,
  ws: null,
  sessionId: generateUUID(),
  history: [],
  pollTimer: null,
};

// ─── DOM Refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  navBtns:           document.querySelectorAll('.nav-btn'),
  views:             { upload: $('uploadView'), history: $('historyView'), transcript: $('transcriptView') },
  dropZone:          $('dropZone'),
  fileInput:         $('fileInput'),
  browseBtn:         $('browseBtn'),
  optionsPanel:      $('optionsPanel'),
  selectedFileName:  $('selectedFileName'),
  selectedFileSize:  $('selectedFileSize'),
  clearFile:         $('clearFile'),
  languageSelect:    $('languageSelect'),
  modelSelect:       $('modelSelect'),
  groqModelGroup:    $('groqModelGroup'),
  localModelGroup:   $('localModelGroup'),
  localModelSelect:  $('localModelSelect'),
  ovModelGroup:      $('ovModelGroup'),
  ovModelSelect:     $('ovModelSelect'),
  ovSourceBtn:       $('ovSourceBtn'),
  sourceOptions:     $('sourceOptions'),
  transcribeBtn:     $('transcribeBtn'),
  progressPanel:     $('progressPanel'),
  progressLabel:     $('progressLabel'),
  progressBar:       $('progressBar'),
  progressFilename:  $('progressFilename'),
  backBtn:           $('backBtn'),
  metaFilename:      $('metaFilename'),
  metaDuration:      $('metaDuration'),
  metaLanguage:      $('metaLanguage'),
  exportBtn:         $('exportBtn'),
  exportMenu:        $('exportMenu'),
  copyBtn:           $('copyBtn'),
  segmentView:       $('segmentView'),
  historyList:       $('historyList'),
  historyEmpty:      $('historyEmpty'),
  apiStatus:         $('apiStatus'),
  toastContainer:    $('toastContainer'),
  // Usage card (home page)
  usageEmpty:        $('usageEmpty'),
  usageData:         $('usageData'),
  ucReqMetric:       $('ucReqMetric'),
  ucReqNums:         $('ucReqNums'),
  ucReqFill:         $('ucReqFill'),
  ucAudioMetric:     $('ucAudioMetric'),
  ucAudioNums:       $('ucAudioNums'),
  ucAudioFill:       $('ucAudioFill'),
  ucReset:           $('ucReset'),
};

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'register', sessionId: state.sessionId }));
    setStatus(true);
  });

  ws.addEventListener('message', (e) => {
    try { handleWsMessage(JSON.parse(e.data)); } catch (_) {}
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
  if (msg.id && msg.id !== state.currentTranscriptionId) return;

  if (msg.type === 'progress') {
    updateProgress(msg.progress, msg.label || 'Transcribing…');
  } else if (msg.type === 'complete') {
    stopPolling();
    updateProgress(100, 'Done!');
    setTimeout(() => {
      el.progressPanel.hidden = true;
      showToast('Transcription complete!', 'success');
      loadTranscription(msg.id);
    }, 600);
    refreshHistory();
    loadUsage();
  } else if (msg.type === 'error') {
    stopPolling();
    el.progressPanel.hidden = true;
    el.optionsPanel.hidden = false;
    showToast(`Error: ${msg.error}`, 'error', 8000);
    refreshHistory();
  }
}

// ─── Polling fallback (in case WebSocket misses an event) ────────────────────
function startPolling(id) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/transcriptions/${id}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'processing') {
        updateProgress(data.progress || 30, 'Transcribing…');
      } else if (data.status === 'completed') {
        stopPolling();
        updateProgress(100, 'Done!');
        setTimeout(() => {
          el.progressPanel.hidden = true;
          showToast('Transcription complete!', 'success');
          loadTranscription(id);
        }, 600);
        refreshHistory();
        loadUsage();
      } else if (data.status === 'failed') {
        stopPolling();
        el.progressPanel.hidden = true;
        el.optionsPanel.hidden = false;
        showToast(`Error: ${data.error_msg || 'Transcription failed'}`, 'error', 8000);
        refreshHistory();
      }
    } catch (_) { /* network hiccup — try again next tick */ }
  }, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
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

// ─── File Selection ───────────────────────────────────────────────────────────
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return ['mp4','mkv','mov','avi','webm','flv','wmv'].includes(ext) ? '🎬' : '🎵';
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

el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
el.dropZone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => { if (el.fileInput.files[0]) setSelectedFile(el.fileInput.files[0]); });
el.clearFile.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.value = ''; setSelectedFile(null); });

el.dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
el.dropZone.addEventListener('dragleave', ()  => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

// ─── Upload & Transcribe ──────────────────────────────────────────────────────
el.transcribeBtn.addEventListener('click', async () => {
  if (!state.selectedFile) return;

  const src = getSource();
  const formData = new FormData();
  formData.append('file',        state.selectedFile);
  formData.append('language',    el.languageSelect.value   || 'auto');
  formData.append('model',       el.modelSelect.value      || 'whisper-large-v3-turbo');
  formData.append('source',      src);
  formData.append('local_model', el.localModelSelect.value || 'small');
  formData.append('ov_model',    el.ovModelSelect.value    || 'small');

  el.optionsPanel.hidden = true;
  el.progressPanel.hidden = false;
  el.progressFilename.textContent = state.selectedFile.name;
  updateProgress(2, 'Uploading…');

  try {
    const res = await fetch('/api/transcriptions', { method: 'POST', body: formData });

    if (!res.ok) {
      let msg = `Server error ${res.status}`;
      try {
        const body = await res.json();
        // FastAPI returns {"detail": "..."}, Express used {"error": "..."}
        msg = body.detail || body.error || body.message || msg;
      } catch (_) {}
      throw new Error(msg);
    }

    const data = await res.json();
    state.currentTranscriptionId = data.id;
    updateProgress(10, 'Waiting for Groq…');

    // Register transcription ID with WebSocket for live updates
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'register', sessionId: data.id }));
      state.ws.send(JSON.stringify({ type: 'register', sessionId: state.sessionId }));
    }

    // Always start polling as fallback — it stops itself on completion/error
    startPolling(data.id);

  } catch (err) {
    stopPolling();
    el.progressPanel.hidden = true;
    el.optionsPanel.hidden = false;
    showToast(err.message, 'error', 8000);
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
    el.metaLanguage.textContent = (data.language && data.language !== 'auto')
      ? `🌐 ${data.language.toUpperCase()}` : '';

    el.segmentView.innerHTML = '';
    const segments = data.segments || [];
    const hasSpeakers = segments.some(s => s.speaker);

    if (segments.length > 0) {
      let lastSpeaker = null;
      segments.forEach(seg => {
        const div = document.createElement('div');
        div.className = 'segment';

        const timeHtml = `<span class="seg-time">${secondsToMMSS(seg.start)}</span>`;

        if (hasSpeakers && seg.speaker) {
          // Only show badge when speaker changes
          const spkClass = 'spk-' + (seg.speaker.slice(-1).toLowerCase());
          const badgeHtml = (seg.speaker !== lastSpeaker)
            ? `<span class="seg-speaker ${spkClass}">${escapeHtml(seg.speaker)}</span>`
            : '';
          lastSpeaker = seg.speaker;
          div.innerHTML = `${timeHtml}<div class="seg-content">${badgeHtml}<span class="seg-text">${escapeHtml(seg.text.trim())}</span></div>`;
        } else {
          div.innerHTML = `${timeHtml}<span class="seg-text">${escapeHtml(seg.text.trim())}</span>`;
        }

        el.segmentView.appendChild(div);
      });
    } else if (data.transcript) {
      const div = document.createElement('div');
      div.className = 'segment';
      div.innerHTML = `<span class="seg-time">00:00</span>
                       <span class="seg-text">${escapeHtml(data.transcript)}</span>`;
      el.segmentView.appendChild(div);
    }

    state.currentTranscriptionId = id;
    showView('transcript');
    el.fileInput.value = '';
    setSelectedFile(null);
    el.progressPanel.hidden = true;
  } catch (err) {
    showToast('Failed to load transcription: ' + err.message, 'error', 8000);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Export ───────────────────────────────────────────────────────────────────
el.exportBtn.addEventListener('click', (e) => { e.stopPropagation(); el.exportMenu.classList.toggle('open'); });
document.addEventListener('click', () => el.exportMenu.classList.remove('open'));

el.exportMenu.querySelectorAll('.dropdown-item').forEach(item => {
  item.addEventListener('click', () => {
    const id = state.currentTranscriptionId;
    if (id) window.open(`/api/exports/${id}/${item.dataset.format}`, '_blank');
    el.exportMenu.classList.remove('open');
  });
});

el.copyBtn.addEventListener('click', async () => {
  const texts = [...el.segmentView.querySelectorAll('.seg-text')].map(e => e.textContent).join('\n');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texts);
    } else {
      const ta = Object.assign(document.createElement('textarea'),
        { value: texts, style: 'position:fixed;opacity:0' });
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Copied to clipboard!', 'success');
  } catch (_) {
    showToast('Copy failed — select the text manually', 'error');
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
  } catch (_) {}
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

// ─── Groq API Usage Bar ───────────────────────────────────────────────────────
// Groq rate-limit header semantics (confirmed from docs):
//   x-ratelimit-limit-requests   / remaining / reset  → DAILY quota (RPD)
//   x-ratelimit-limit-tokens     / remaining / reset  → PER-MINUTE quota (TPM, in audio seconds)
// There is no programmatic usage API on the free plan — headers are the only source.

function _usageFillClass(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return '';
}

function _resetLabel(resetStr, label) {
  if (!resetStr) return '';
  // Groq returns ISO timestamps or relative seconds strings
  const asNum = Number(resetStr);
  if (!isNaN(asNum)) {
    // Relative seconds
    const diff = Math.max(0, Math.round(asNum));
    if (diff <= 0) return `${label} resets now`;
    const m = Math.floor(diff / 60), s = diff % 60;
    return m > 0 ? `${label} resets in ${m}m ${s}s` : `${label} resets in ${s}s`;
  }
  try {
    const ts = new Date(resetStr);
    if (!isNaN(ts)) {
      const diff = Math.max(0, Math.round((ts - Date.now()) / 1000));
      if (diff <= 0) return `${label} resets now`;
      const m = Math.floor(diff / 60), s = diff % 60;
      if (diff > 3600) return `${label} resets in ${Math.round(diff/3600)}h`;
      return m > 0 ? `${label} resets in ${m}m ${s}s` : `${label} resets in ${s}s`;
    }
  } catch (_) {}
  return '';
}

async function loadUsage() {
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) return;
    const d = await res.json();

    if (!d.last_updated) return;   // no transcription done yet — keep placeholder

    // Switch from placeholder to live data
    el.usageEmpty.hidden = true;
    el.usageData.hidden  = false;

    // ── Daily requests bar (RPD) ──────────────────────────────────────────────
    if (d.requests_limit != null && d.requests_remaining != null) {
      const used = d.requests_limit - d.requests_remaining;
      const pct  = Math.min(100, Math.round(used / d.requests_limit * 100));
      el.ucReqNums.textContent = `${d.requests_remaining.toLocaleString()} / ${d.requests_limit.toLocaleString()} left`;
      el.ucReqFill.style.width = pct + '%';
      el.ucReqFill.className   = 'usage-fill ' + _usageFillClass(pct);
      el.ucReqMetric.hidden    = false;
    }

    // ── Per-minute audio seconds bar (TPM) ────────────────────────────────────
    if (d.tokens_limit != null && d.tokens_remaining != null) {
      const used = d.tokens_limit - d.tokens_remaining;
      const pct  = Math.min(100, Math.round(used / d.tokens_limit * 100));
      const fmt  = (s) => s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
      el.ucAudioNums.textContent = `${fmt(d.tokens_remaining)} / ${fmt(d.tokens_limit)} left`;
      el.ucAudioFill.style.width = pct + '%';
      el.ucAudioFill.className   = 'usage-fill ' + _usageFillClass(pct);
      el.ucAudioMetric.hidden    = false;
    }

    // ── Reset label ───────────────────────────────────────────────────────────
    const resets = [
      _resetLabel(d.requests_reset, 'Daily quota'),
      _resetLabel(d.tokens_reset,   'Audio quota'),
    ].filter(Boolean);
    el.ucReset.textContent = resets[0] || '';

  } catch (_) {}
}

// ─── Source (engine) selector ─────────────────────────────────────────────────
function getSource() {
  return el.sourceOptions.querySelector('.source-btn.active')?.dataset.value || 'groq';
}

function initSourceSelector() {
  el.sourceOptions.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.sourceOptions.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.querySelector('input').checked = true;
      const src = btn.dataset.value;
      el.groqModelGroup.hidden  = (src === 'local' || src === 'openvino');
      el.localModelGroup.hidden = (src === 'groq'  || src === 'openvino');
      el.ovModelGroup.hidden    = (src !== 'openvino');
    });
  });
}

// ─── Metadata (models + languages) ───────────────────────────────────────────
async function loadMeta() {
  try {
    const res = await fetch('/api/transcriptions/meta');
    if (!res.ok) return;
    const { models, languages, local_models, ov_models, ov_available } = await res.json();
    el.languageSelect.innerHTML = languages.map(l =>
      `<option value="${l.code}">${l.label}</option>`).join('');
    el.modelSelect.innerHTML = models.map(m =>
      `<option value="${m.id}">${m.label}</option>`).join('');
    if (local_models?.length) {
      el.localModelSelect.innerHTML = local_models.map(m => {
        const cached = m.cached ? ' ✓ cached' : '';
        return `<option value="${m.id}">${m.label}${cached}</option>`;
      }).join('');
      el.localModelSelect.value = 'small';
    }
    if (ov_models?.length) {
      el.ovModelSelect.innerHTML = ov_models.map(m => {
        const cached = m.cached ? ' ✓ cached' : '';
        return `<option value="${m.id}">${m.label}${cached}</option>`;
      }).join('');
      el.ovModelSelect.value = 'small';
    }
    // Grey out OpenVINO button if the package isn't installed in this image
    if (el.ovSourceBtn) {
      el.ovSourceBtn.title = ov_available
        ? 'Intel GPU via OpenVINO'
        : 'OpenVINO not installed — rebuild with --build-arg WITH_OPENVINO=true';
      el.ovSourceBtn.style.opacity = ov_available ? '' : '0.45';
      el.ovSourceBtn.style.cursor  = ov_available ? '' : 'not-allowed';
      if (!ov_available) {
        el.ovSourceBtn.addEventListener('click', (e) => e.stopImmediatePropagation(), true);
      }
    }
  } catch (_) {}
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 5000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
connectWS();
loadMeta();
loadUsage();
initSourceSelector();
