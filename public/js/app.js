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
  currentView:            'upload',
  selectedFile:           null,
  preprocessId:           null,
  audioDuration:          null,
  currentTranscriptionId: null,
  currentData:            null,   // full loaded transcription object
  ws:                     null,
  sessionId:              generateUUID(),
  history:                [],
  pollTimer:              null,
  transcriptionStartTime: null,
  editMode:               false,
  saveTimer:              null,
  savePending:            false,
};

// ─── Audio Player ─────────────────────────────────────────────────────────────
const player = {
  audio:      new Audio(),
  txId:       null,   // transcription id currently loaded
  wordSpans:  [],     // cached word <span> elements for karaoke
  rafId:      null,
  activeSpan: null,
};

// ─── DOM Refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  navBtns:              document.querySelectorAll('.nav-btn'),
  views:                { upload: $('uploadView'), history: $('historyView'), transcript: $('transcriptView') },
  dropZone:             $('dropZone'),
  fileInput:            $('fileInput'),
  browseBtn:            $('browseBtn'),
  optionsPanel:         $('optionsPanel'),
  selectedFileName:     $('selectedFileName'),
  selectedFileDuration: $('selectedFileDuration'),
  clearFile:            $('clearFile'),
  languageSelect:       $('languageSelect'),
  modelSelect:          $('modelSelect'),
  groqModelGroup:       $('groqModelGroup'),
  ovModelGroup:         $('ovModelGroup'),
  ovModelSelect:        $('ovModelSelect'),
  ovSourceBtn:          $('ovSourceBtn'),
  sourceOptions:        $('sourceOptions'),
  uploadHint:           $('uploadHint'),
  transcribeBtn:        $('transcribeBtn'),
  progressPanel:        $('progressPanel'),
  progressLabel:        $('progressLabel'),
  progressBar:          $('progressBar'),
  progressFilename:     $('progressFilename'),
  progressEta:          $('progressEta'),
  phaseSection:         $('phaseSection'),
  phaseLabel:           $('phaseLabel'),
  phaseBar:             $('phaseBar'),
  phasePct:             $('phasePct'),
  backBtn:              $('backBtn'),
  metaFilename:         $('metaFilename'),
  metaDuration:         $('metaDuration'),
  metaLanguage:         $('metaLanguage'),
  exportBtn:            $('exportBtn'),
  exportMenu:           $('exportMenu'),
  copyBtn:              $('copyBtn'),
  segmentView:          $('segmentView'),
  historyList:          $('historyList'),
  historyEmpty:         $('historyEmpty'),
  bulkBar:              $('bulkBar'),
  bulkCount:            $('bulkCount'),
  bulkDeleteBtn:        $('bulkDeleteBtn'),
  selectAllCheck:       $('selectAllCheck'),
  apiStatus:            $('apiStatus'),
  toastContainer:       $('toastContainer'),
  usageEmpty:           $('usageEmpty'),
  usageData:            $('usageData'),
  ucReqMetric:          $('ucReqMetric'),
  ucReqNums:            $('ucReqNums'),
  ucReqFill:            $('ucReqFill'),
  ucAudioMetric:        $('ucAudioMetric'),
  ucAudioNums:          $('ucAudioNums'),
  ucAudioFill:          $('ucAudioFill'),
  ucReset:              $('ucReset'),
  editToggleBtn:        $('editToggleBtn'),
  editIcon:             $('editIcon'),
  saveIcon:             $('saveIcon'),
  transcriptPlayer:     $('transcriptPlayer'),
  playerPlayBtn:        $('playerPlayBtn'),
  playerPlayIcon:       $('playerPlayIcon'),
  playerPauseIcon:      $('playerPauseIcon'),
  playerCurrent:        $('playerCurrent'),
  playerTotal:          $('playerTotal'),
  playerSeek:           $('playerSeek'),
  playerMuteBtn:        $('playerMuteBtn'),
  playerVolume:         $('playerVolume'),
  volIconHigh:          $('volIconHigh'),
  volIconLow:           $('volIconLow'),
  volIconMute:          $('volIconMute'),
  playerCloseBtn:       $('playerCloseBtn'),
  historySearch:    $('historySearch'),
  historySearchCount: $('historySearchCount'),
  findReplaceBtn:   $('findReplaceBtn'),
  findReplaceBar:   $('findReplaceBar'),
  confToggleBtn:    $('confToggleBtn'),
  frFind:           $('frFind'),
  frReplace:        $('frReplace'),
  frCount:          $('frCount'),
  frPrev:           $('frPrev'),
  frNext:           $('frNext'),
  frReplaceOne:     $('frReplaceOne'),
  frReplaceAll:     $('frReplaceAll'),
  frClose:          $('frClose'),
  frReplaceRow:     $('frReplaceRow'),
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
  // ── Preprocessing events ──────────────────────────────────────────────────
  if (msg.type === 'preprocess_progress') {
    if (msg.preprocess_id !== state.preprocessId) return;
    updateProgress(
      5 + Math.round((msg.phase_pct || 0) * 0.25),
      msg.label || 'Preprocessing audio…',
      'preprocess',
      msg.phase_pct ?? 0,
    );
    return;
  }

  if (msg.type === 'preprocess_done') {
    if (msg.preprocess_id !== state.preprocessId) return;
    state.audioDuration = msg.duration_s ?? null;
    _showOptionsAfterPreprocess(msg.duration_s);
    return;
  }

  if (msg.type === 'preprocess_error') {
    if (msg.preprocess_id !== state.preprocessId) return;
    clearSelection();
    showToast(`Preprocessing failed: ${msg.error}`, 'error', 8000);
    return;
  }

  // ── Transcription events ──────────────────────────────────────────────────
  if (msg.id && msg.id !== state.currentTranscriptionId) return;

  if (msg.type === 'progress') {
    updateProgress(msg.progress, msg.label || 'Transcribing…', msg.phase, msg.phase_pct);
  } else if (msg.type === 'complete') {
    stopPolling();
    updateProgress(100, 'Done!', null, null);
    setTimeout(() => {
      state.transcriptionStartTime = null;
      el.progressPanel.hidden = true;
      el.progressEta.textContent = '';
      el.phaseSection.hidden = true;
      showToast('Transcription complete!', 'success');
      loadTranscription(msg.id);
    }, 600);
    refreshHistory();
    loadUsage();
  } else if (msg.type === 'error') {
    stopPolling();
    state.transcriptionStartTime = null;
    el.progressPanel.hidden = true;
    el.progressEta.textContent = '';
    el.phaseSection.hidden = true;
    el.optionsPanel.hidden = false;
    showToast(`Error: ${msg.error}`, 'error', 8000);
    refreshHistory();
  }
}

// After preprocessing completes, show the options panel with duration info
function _showOptionsAfterPreprocess(duration_s) {
  el.progressPanel.hidden = true;
  el.phaseSection.hidden  = true;
  el.progressEta.textContent = '';

  el.selectedFileName.textContent = state.selectedFile?.name || '';
  el.selectedFileDuration.textContent = duration_s
    ? '⏱ ' + secondsToHMMSS(duration_s)
    : '';
  el.optionsPanel.querySelector('.file-icon').textContent =
    getFileIcon(state.selectedFile?.name || '');
  el.optionsPanel.hidden = false;
}

// ─── Polling fallback (transcription only) ────────────────────────────────────
function startPolling(id) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/transcriptions/${id}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'processing') {
        updateProgress(data.progress || 30, 'Transcribing…', null, null);
      } else if (data.status === 'completed') {
        stopPolling();
        updateProgress(100, 'Done!', null, null);
        setTimeout(() => {
          state.transcriptionStartTime = null;
          el.progressPanel.hidden = true;
          el.progressEta.textContent = '';
          el.phaseSection.hidden = true;
          showToast('Transcription complete!', 'success');
          loadTranscription(id);
        }, 600);
        refreshHistory();
        loadUsage();
      } else if (data.status === 'failed') {
        stopPolling();
        state.transcriptionStartTime = null;
        el.progressPanel.hidden = true;
        el.progressEta.textContent = '';
        el.phaseSection.hidden = true;
        el.optionsPanel.hidden = false;
        showToast(`Error: ${data.error_msg || 'Transcription failed'}`, 'error', 8000);
        refreshHistory();
      }
    } catch (_) {}
  }, 2000);
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
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

  if (name === 'history') refreshHistory(el.historySearch?.value?.trim() || '');
}

el.navBtns.forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

// ─── File Selection + auto-preprocess ────────────────────────────────────────
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return ['mp4','mkv','mov','avi','webm','flv','wmv'].includes(ext) ? '🎬' : '🎵';
}

function clearSelection() {
  state.selectedFile  = null;
  state.preprocessId  = null;
  state.audioDuration = null;
  el.optionsPanel.hidden  = true;
  el.progressPanel.hidden = true;
  el.phaseSection.hidden  = true;
  el.progressEta.textContent = '';
  el.fileInput.value = '';
}

el.clearFile.addEventListener('click', (e) => { e.stopPropagation(); clearSelection(); });

el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
el.dropZone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files[0]) handleFileSelected(el.fileInput.files[0]);
});

el.dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
el.dropZone.addEventListener('dragleave', ()  => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelected(file);
});

async function handleFileSelected(file) {
  clearSelection();   // cancel any in-progress preprocessing
  state.selectedFile = file;

  // Show preprocessing progress immediately
  el.progressFilename.textContent = file.name;
  el.progressEta.textContent = '';
  el.progressPanel.hidden = false;
  el.phaseSection.hidden  = false;
  el.phaseBar.style.width = '0%';
  el.phasePct.textContent = '0%';
  updateProgress(3, 'Uploading…', 'preprocess', 0);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/transcriptions/preprocess', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Upload failed (${res.status})`);
    }
    const { preprocess_id } = await res.json();
    state.preprocessId = preprocess_id;

    // Subscribe to preprocessing events on this channel
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'register', sessionId: preprocess_id }));
    }

    updateProgress(5, 'Preprocessing audio…', 'preprocess', 0);

  } catch (err) {
    clearSelection();
    showToast(err.message, 'error', 8000);
  }
}

// ─── Upload & Transcribe ──────────────────────────────────────────────────────
el.transcribeBtn.addEventListener('click', async () => {
  if (!state.preprocessId) return;

  const src = getSource();

  const formData = new FormData();
  formData.append('preprocess_id', state.preprocessId);
  formData.append('language',      el.languageSelect.value  || 'auto');
  formData.append('model',         el.modelSelect.value     || 'whisper-large-v3-turbo');
  formData.append('source',        src);
  formData.append('ov_model',      el.ovModelSelect.value   || 'small');

  el.optionsPanel.hidden      = true;
  el.progressPanel.hidden     = false;
  el.phaseSection.hidden      = true;
  el.progressFilename.textContent = state.selectedFile?.name || '';
  el.progressEta.textContent  = '';
  state.transcriptionStartTime = Date.now();
  updateProgress(3, 'Starting transcription…', null, null);

  try {
    const res = await fetch('/api/transcriptions', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `Server error ${res.status}`);
    }

    const data = await res.json();
    state.currentTranscriptionId = data.id;
    state.preprocessId = null;   // consumed

    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'register', sessionId: data.id }));
      state.ws.send(JSON.stringify({ type: 'register', sessionId: state.sessionId }));
    }

    startPolling(data.id);

  } catch (err) {
    stopPolling();
    state.transcriptionStartTime = null;
    el.progressPanel.hidden  = true;
    el.optionsPanel.hidden   = false;
    showToast(err.message, 'error', 8000);
  }
});

// ─── Progress + Phase bar + ETA ───────────────────────────────────────────────
function updateProgress(pct, label, phase, phasePct) {
  el.progressBar.style.width = pct + '%';
  if (label) el.progressLabel.textContent = label;

  if (phase === 'preprocess' && phasePct != null) {
    el.phaseSection.hidden  = false;
    el.phaseBar.style.width = phasePct + '%';
    el.phasePct.textContent = phasePct + '%';
    el.phaseLabel.textContent = 'Preprocessing';
  } else if (phase == null || phase !== 'preprocess') {
    el.phaseSection.hidden = true;
  }

  // ETA only during transcription (not preprocessing)
  if (state.transcriptionStartTime && pct > 30 && pct < 95) {
    const elapsed = (Date.now() - state.transcriptionStartTime) / 1000;
    if (elapsed > 4) {
      const rate = pct / elapsed;
      const remaining = Math.ceil((100 - pct) / rate);
      if (remaining > 3) {
        const m = Math.floor(remaining / 60), s = remaining % 60;
        el.progressEta.textContent = m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
      } else {
        el.progressEta.textContent = '';
      }
    }
  } else if (pct >= 95 || !state.transcriptionStartTime) {
    el.progressEta.textContent = '';
  }
}

// ─── Transcript Display ───────────────────────────────────────────────────────
function secondsToMMSS(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function secondsToHMMSS(s) {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
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
    const segments    = data.segments || [];
    const words       = data.words    || [];
    const hasSpeakers = segments.some(s => s.speaker);
    const hasWords    = words.length > 0;
    // Track whether confidence data exists at all (separate from whether any words are flagged)
    const hasConfData = segments.some(s => s.avg_logprob != null)
                     || words.some(w => w.probability != null);
    el.segmentView.dataset.hasConf = hasConfData ? 'true' : 'false';

    if (segments.length > 0) {
      let lastSpeaker = null;
      let wi = 0;

      segments.forEach(seg => {
        const div = document.createElement('div');
        div.className = 'segment';
        const timeHtml = `<span class="seg-time" data-t="${seg.start}">${secondsToMMSS(seg.start)}</span>`;

        let bodyHtml;
        if (hasWords) {
          let whtml = '';
          let wordIdx = 0;
          const segLogp = seg.avg_logprob ?? null; // fallback when Groq omits per-word probability
          while (wi < words.length && words[wi].start < seg.end - 0.05) {
            const w = words[wi++];
            // Ensure a space precedes every word except the first in the segment
            const text = (wordIdx > 0 && !w.word.startsWith(' ') && !w.word.startsWith('\n'))
              ? ' ' + w.word : w.word;
            let confAttr = '';
            if (w.probability != null) {
              // Per-word probability 0–1 (Groq may not supply this)
              if (w.probability < 0.65) confAttr = ' data-conf="low"';
              else if (w.probability < 0.85) confAttr = ' data-conf="mid"';
            } else if (segLogp != null) {
              // Segment avg_logprob (negative; less negative = more confident)
              if (segLogp < -0.7) confAttr = ' data-conf="low"';
              else if (segLogp < -0.3) confAttr = ' data-conf="mid"';
            }
            whtml += `<span class="word" data-s="${w.start}" data-e="${w.end}"${confAttr}>${escapeHtml(text)}</span>`;
            wordIdx++;
          }
          bodyHtml = whtml || `<span class="seg-text">${escapeHtml(seg.text.trim())}</span>`;
        } else {
          let segConf = '';
          const lp = seg.avg_logprob ?? null;
          if (lp != null) {
            if (lp < -0.7) segConf = ' data-conf="low"';
            else if (lp < -0.3) segConf = ' data-conf="mid"';
          }
          bodyHtml = `<span class="seg-text"${segConf}>${escapeHtml(seg.text.trim())}</span>`;
        }

        if (hasSpeakers && seg.speaker) {
          const spkClass  = 'spk-' + seg.speaker.slice(-1).toLowerCase();
          const badgeHtml = seg.speaker !== lastSpeaker
            ? `<span class="seg-speaker ${spkClass}">${escapeHtml(seg.speaker)}</span>` : '';
          lastSpeaker = seg.speaker;
          div.innerHTML = `${timeHtml}<div class="seg-content">${badgeHtml}<span class="seg-words">${bodyHtml}</span></div>`;
        } else {
          div.innerHTML = `${timeHtml}<span class="seg-words">${bodyHtml}</span>`;
        }
        el.segmentView.appendChild(div);
      });

      if (hasWords && wi < words.length) {
        const lastWords = el.segmentView.querySelector('.segment:last-child .seg-words');
        if (lastWords) {
          while (wi < words.length) {
            const w = words[wi++];
            const sp = document.createElement('span');
            sp.className = 'word';
            sp.dataset.s = w.start;
            sp.dataset.e = w.end;
            sp.textContent = w.word;
            lastWords.appendChild(sp);
          }
        }
      }
    } else if (data.transcript) {
      const div = document.createElement('div');
      div.className = 'segment';
      div.innerHTML = `<span class="seg-time">00:00</span>
                       <span class="seg-text">${escapeHtml(data.transcript)}</span>`;
      el.segmentView.appendChild(div);
    }

    // Cache word spans for karaoke and wire up click-to-seek
    player.wordSpans = Array.from(el.segmentView.querySelectorAll('.word[data-s]'));
    player.wordSpans.forEach(sp => {
      sp.addEventListener('click', () => playerSeekTo(id, parseFloat(sp.dataset.s)));
    });
    el.segmentView.querySelectorAll('.seg-time[data-t]').forEach(sp => {
      sp.addEventListener('click', () => playerSeekTo(id, parseFloat(sp.dataset.t)));
      sp.style.cursor = 'pointer';
    });

    state.currentTranscriptionId = id;
    state.currentData            = data;
    state.editMode               = false;  // always start in view mode
    _confMode                    = false;
    el.segmentView.classList.remove('conf-mode');
    if (el.confToggleBtn) { el.confToggleBtn.classList.remove('conf-active'); el.confToggleBtn.title = 'Show confidence highlighting'; }
    const confBanner = document.getElementById('confNoBanner');
    if (confBanner) confBanner.hidden = true;
    _syncEditBtn();
    el.transcriptPlayer.hidden = (player.txId !== id);
    showView('transcript');
    clearSelection();
    el.progressPanel.hidden = true;
  } catch (err) {
    showToast('Failed to load transcription: ' + err.message, 'error', 8000);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Edit mode ────────────────────────────────────────────────────────────────
function _syncEditBtn() {
  if (!el.editToggleBtn) return;
  el.editIcon.hidden = state.editMode;
  el.saveIcon.hidden = !state.editMode;
  el.editToggleBtn.classList.toggle('editing', state.editMode);
  el.editToggleBtn.title = state.editMode ? 'Save edits' : 'Edit transcript';
  if (el.frReplaceRow) el.frReplaceRow.hidden = !state.editMode;
  if (el.frReplaceOne) el.frReplaceOne.disabled = !state.editMode;
  if (el.frReplaceAll) el.frReplaceAll.disabled = !state.editMode;
}

function enterEditMode() {
  if (state.editMode) return;
  state.editMode = true;
  cancelAnimationFrame(player.rafId); // pause karaoke during editing

  el.segmentView.querySelectorAll('.seg-words, .seg-text').forEach(container => {
    // Replace inner spans with plain text so contenteditable is clean
    container.textContent = container.innerText;
    container.contentEditable = 'true';
    container.spellcheck = true;
    container.addEventListener('input', _onEditInput);
  });

  _syncEditBtn();
}

function exitEditMode() {
  if (!state.editMode) return;
  clearTimeout(state.saveTimer);
  state.editMode = false;

  // Collect edits and persist
  const containers = [...el.segmentView.querySelectorAll('[contenteditable="true"]')];
  containers.forEach(c => {
    c.removeEventListener('input', _onEditInput);
    c.removeAttribute('contenteditable');
    c.removeAttribute('spellcheck');
  });

  _flushEdits(containers);
  _syncEditBtn();
  _removeSaveDot();
}

function _onEditInput() {
  _showSaveDot();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    const containers = [...el.segmentView.querySelectorAll('[contenteditable="true"]')];
    _flushEdits(containers);
  }, 1500);
}

async function _flushEdits(containers) {
  if (!state.currentData || !state.currentTranscriptionId) return;

  // Rebuild segments from edited text
  const segs = (state.currentData.segments || []).map((seg, i) => {
    const text = containers[i] ? containers[i].innerText.replace(/\n/g, ' ').trim() : seg.text;
    return { ...seg, text };
  });
  const transcript = segs.map(s => s.text).join(' ');

  // Optimistically update local state
  state.currentData = { ...state.currentData, segments: segs, transcript };

  try {
    await fetch(`/api/transcriptions/${state.currentTranscriptionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, segments: segs }),
    });
    _removeSaveDot();
  } catch {
    showToast('Failed to save edits', 'error');
  }
}

function _showSaveDot() {
  if (el.editToggleBtn.querySelector('.save-dot')) return;
  const dot = document.createElement('span');
  dot.className = 'save-dot';
  el.editToggleBtn.appendChild(dot);
}

function _removeSaveDot() {
  el.editToggleBtn.querySelector('.save-dot')?.remove();
}

el.editToggleBtn?.addEventListener('click', () => {
  if (state.editMode) exitEditMode();
  else enterEditMode();
});

// ─── Find & Replace ───────────────────────────────────────────────────────────
let _frMatches = [];
let _frCurrent = -1;
let _confMode  = false;

function _escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _openFindReplace() {
  if (!el.findReplaceBar || !el.findReplaceBtn || !el.frFind) return;
  el.findReplaceBar.hidden = false;
  el.findReplaceBtn.classList.add('active');
  el.frFind.focus();
  el.frFind.select();
  _frSearch();
}

function _closeFindReplace() {
  if (!el.findReplaceBar || !el.findReplaceBtn) return;
  el.findReplaceBar.hidden = true;
  el.findReplaceBtn.classList.remove('active');
  _frMatches = [];
  _frCurrent = -1;
  _frUpdateCount();
}

function _frContainers() {
  // In edit mode use contenteditable; in view mode use seg-words/seg-text text
  return [...el.segmentView.querySelectorAll(
    state.editMode ? '[contenteditable="true"]' : '.seg-words, .seg-text'
  )];
}

function _frSearch() {
  const q = el.frFind.value;
  _frMatches = [];
  if (!q) { _frUpdateCount(); return; }
  const qL = q.toLowerCase();
  _frContainers().forEach((c, ci) => {
    const txt = c.innerText.toLowerCase();
    let idx = 0;
    while ((idx = txt.indexOf(qL, idx)) !== -1) {
      _frMatches.push({ ci, idx });
      idx++;
    }
  });
  _frCurrent = _frMatches.length > 0 ? 0 : -1;
  _frUpdateCount();
  _frScrollToCurrent();
}

function _frUpdateCount() {
  if (!el.frCount) return;
  const q = el.frFind?.value || '';
  el.frCount.textContent = !q ? '' : _frMatches.length === 0 ? 'No results' : `${_frCurrent + 1} / ${_frMatches.length}`;
}

function _frScrollToCurrent() {
  if (_frCurrent < 0 || !_frMatches.length) return;
  const containers = _frContainers();
  const { ci, idx } = _frMatches[_frCurrent];
  const c = containers[ci];
  if (!c) return;
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  c.classList.add('fr-highlight');
  setTimeout(() => c.classList.remove('fr-highlight'), 1500);

  // Select the matched text so the user can see exactly which word matched
  try {
    const q = el.frFind.value;
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, null);
    let offset = 0, node = walker.nextNode();
    while (node) {
      const len = node.textContent.length;
      if (offset + len > idx) {
        const range = document.createRange();
        range.setStart(node, idx - offset);
        range.setEnd(node, Math.min(idx - offset + q.length, len));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      }
      offset += len;
      node = walker.nextNode();
    }
  } catch (_) {}
}

function _frNav(dir) {
  if (!_frMatches.length) return;
  _frCurrent = (_frCurrent + dir + _frMatches.length) % _frMatches.length;
  _frUpdateCount();
  _frScrollToCurrent();
}

function _frReplaceOne() {
  if (!state.editMode || _frCurrent < 0 || !_frMatches.length) return;
  const q = el.frFind.value, r = el.frReplace.value;
  if (!q) return;
  const containers = _frContainers();
  const { ci, idx } = _frMatches[_frCurrent];
  const c = containers[ci];
  if (!c) return;
  const txt = c.innerText;
  c.innerText = txt.slice(0, idx) + r + txt.slice(idx + q.length);
  _onEditInput();
  _frSearch();
}

function _frReplaceAll() {
  if (!state.editMode) return;
  const q = el.frFind.value, r = el.frReplace.value;
  if (!q) return;
  const re = new RegExp(_escapeRegex(q), 'gi');
  let count = 0;
  _frContainers().forEach(c => {
    const newTxt = c.innerText.replace(re, () => { count++; return r; });
    if (newTxt !== c.innerText) c.innerText = newTxt;
  });
  _onEditInput();
  showToast(count ? `Replaced ${count} occurrence${count > 1 ? 's' : ''}` : 'No matches found', count ? 'success' : 'info');
  _frSearch();
}

// Find & Replace event listeners
el.findReplaceBtn?.addEventListener('click', () => {
  if (!el.findReplaceBar || el.findReplaceBar.hidden) _openFindReplace();
  else _closeFindReplace();
});
el.frClose?.addEventListener('click', _closeFindReplace);
el.frFind?.addEventListener('input', _frSearch);
el.frFind?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); _frNav(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') _closeFindReplace();
});
el.frPrev?.addEventListener('click', () => _frNav(-1));
el.frNext?.addEventListener('click', () => _frNav(1));
el.frReplaceOne?.addEventListener('click', _frReplaceOne);
el.frReplaceAll?.addEventListener('click', _frReplaceAll);

// Keyboard shortcut: Ctrl+H opens find/replace
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'h' && state.currentView === 'transcript') {
    e.preventDefault();
    if (!state.editMode) enterEditMode();
    _openFindReplace();
    el.frReplace?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && state.currentView === 'transcript') {
    e.preventDefault();
    _openFindReplace();
  }
});

// ─── Confidence toggle ────────────────────────────────────────────────────────
el.confToggleBtn?.addEventListener('click', () => {
  _confMode = !_confMode;
  el.segmentView.classList.toggle('conf-mode', _confMode);
  el.confToggleBtn.classList.toggle('conf-active', _confMode);
  el.confToggleBtn.title = _confMode ? 'Hide confidence highlighting' : 'Show confidence highlighting';
  const noData = _confMode && el.segmentView.dataset.hasConf !== 'true';
  const banner = document.getElementById('confNoBanner');
  if (banner) banner.hidden = !noData;
});

// ─── Player ───────────────────────────────────────────────────────────────────
let _prevVolume = 1; // remember volume before mute

function playerLoad(txId) {
  if (player.txId === txId) return; // already loaded — keep existing state
  player.txId = txId;
  player.audio.src = `/api/transcriptions/${txId}/audio`;
  player.audio.load();
  el.playerTotal.textContent   = '…';
  el.playerCurrent.textContent = '0:00';
  el.playerSeek.value          = 0;
  el.transcriptPlayer.hidden   = false;
}

// Seek to time t in transcript txId; if not loaded yet, wait for canplay
function playerSeekTo(txId, t) {
  if (player.txId !== txId) {
    playerLoad(txId);
    player.audio.addEventListener('canplay', function onReady() {
      player.audio.removeEventListener('canplay', onReady);
      player.audio.currentTime = t;
      player.audio.play();
    });
  } else {
    player.audio.currentTime = t;
    player.audio.play();
  }
}

function playerToggle(txId) {
  playerLoad(txId);
  if (player.audio.paused) player.audio.play();
  else player.audio.pause();
}

function playerClose() {
  player.audio.pause();
  player.audio.src  = '';
  player.txId       = null;
  player.wordSpans  = [];
  player.activeSpan = null;
  cancelAnimationFrame(player.rafId);
  el.transcriptPlayer.hidden = true;
  _syncHistoryPlayBtns();
}

// Karaoke: advance highlight every animation frame while playing
function _karaokeFrame() {
  if (player.audio.paused) return;

  // Lazily refresh spans if the current transcript is showing but spans not yet cached
  if (player.wordSpans.length === 0 && player.txId === state.currentTranscriptionId) {
    player.wordSpans = Array.from(el.segmentView.querySelectorAll('.word[data-s]'));
  }

  const t     = player.audio.currentTime;
  const spans = player.wordSpans;

  // Binary search: last span whose start ≤ t  (highlights the word being spoken)
  let lo = 0, hi = spans.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parseFloat(spans[mid].dataset.s) <= t) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }

  const next = found >= 0 ? spans[found] : null;
  if (next !== player.activeSpan) {
    player.activeSpan?.classList.remove('k-on');
    next?.classList.add('k-on');
    player.activeSpan = next;
    if (next && player.txId === state.currentTranscriptionId) {
      next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  player.rafId = requestAnimationFrame(_karaokeFrame);
}

function _updateVolIcon() {
  const v = player.audio.muted ? 0 : player.audio.volume;
  el.volIconHigh.hidden = !(v > 0.4);
  el.volIconLow.hidden  = !(v > 0 && v <= 0.4);
  el.volIconMute.hidden = !(v === 0 || player.audio.muted);
}

function _syncHistoryPlayBtns() {
  document.querySelectorAll('.hist-play').forEach(btn => {
    const active = !player.audio.paused && btn.dataset.id === player.txId;
    btn.classList.toggle('active', active);
    const ico = btn.querySelector('.hp-icon');
    if (ico) ico.textContent = active ? '⏸' : '▶';
  });
}

// ── Audio element events ──────────────────────────────────────────────────────
player.audio.addEventListener('play', () => {
  el.transcriptPlayer.hidden = false;
  el.playerPlayIcon.hidden   = true;
  el.playerPauseIcon.hidden  = false;
  el.playerPlayBtn.classList.remove('paused');
  _syncHistoryPlayBtns();
  cancelAnimationFrame(player.rafId);
  player.rafId = requestAnimationFrame(_karaokeFrame);
});

player.audio.addEventListener('pause', () => {
  el.playerPlayIcon.hidden  = false;
  el.playerPauseIcon.hidden = true;
  el.playerPlayBtn.classList.add('paused');
  _syncHistoryPlayBtns();
  cancelAnimationFrame(player.rafId);
});

player.audio.addEventListener('ended', () => {
  player.audio.currentTime  = 0;
  el.playerPlayIcon.hidden  = false;
  el.playerPauseIcon.hidden = true;
  el.playerPlayBtn.classList.add('paused');
  player.activeSpan?.classList.remove('k-on');
  player.activeSpan = null;
  el.playerSeek.value = 0;
  el.playerCurrent.textContent = secondsToMMSS(0);
  _syncHistoryPlayBtns();
});

player.audio.addEventListener('timeupdate', () => {
  const t = player.audio.currentTime;
  const d = player.audio.duration || 0;
  el.playerCurrent.textContent = secondsToMMSS(t);
  if (d > 0) el.playerSeek.value = t / d;
});

player.audio.addEventListener('durationchange', () => {
  const d = player.audio.duration;
  if (d && isFinite(d)) el.playerTotal.textContent = secondsToMMSS(d);
});

player.audio.addEventListener('error', () => {
  showToast('Audio playback error — file may have been deleted', 'error');
  playerClose();
});

// ── Player controls ───────────────────────────────────────────────────────────
el.playerPlayBtn.addEventListener('click', () => {
  if (player.audio.paused) player.audio.play();
  else player.audio.pause();
});

el.playerCloseBtn.addEventListener('click', playerClose);

el.playerSeek.addEventListener('input', () => {
  const d = player.audio.duration || 0;
  if (d > 0) player.audio.currentTime = parseFloat(el.playerSeek.value) * d;
});

el.playerVolume.addEventListener('input', () => {
  const v = parseFloat(el.playerVolume.value);
  player.audio.volume = v;
  player.audio.muted  = (v === 0);
  _prevVolume = v > 0 ? v : _prevVolume;
  _updateVolIcon();
});

el.playerMuteBtn.addEventListener('click', () => {
  if (player.audio.muted || player.audio.volume === 0) {
    player.audio.muted  = false;
    player.audio.volume = _prevVolume || 1;
    el.playerVolume.value = player.audio.volume;
  } else {
    _prevVolume = player.audio.volume;
    player.audio.muted = true;
    el.playerVolume.value = 0;
  }
  _updateVolIcon();
});

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
  const texts = [...el.segmentView.querySelectorAll('.seg-words, .seg-text')].map(e => e.innerText.trim()).join('\n');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texts);
    } else {
      const ta = Object.assign(document.createElement('textarea'),
        { value: texts, style: 'position:fixed;opacity:0' });
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Copied to clipboard!', 'success');
  } catch (_) { showToast('Copy failed — select the text manually', 'error'); }
});

// ─── Back Button ─────────────────────────────────────────────────────────────
el.backBtn.addEventListener('click', () => { exitEditMode(); showView('upload'); });

// ─── History ─────────────────────────────────────────────────────────────────
async function refreshHistory(q = '') {
  try {
    const url = q ? `/api/transcriptions?q=${encodeURIComponent(q)}` : '/api/transcriptions';
    const res = await fetch(url);
    const items = await res.json();
    state.history = items;
    renderHistory(items, q);
    if (el.historySearchCount) {
      el.historySearchCount.textContent = q ? `${items.length} result${items.length !== 1 ? 's' : ''}` : '';
    }
  } catch (_) {}
}

function getSelectedIds() {
  return [...el.historyList.querySelectorAll('.history-check:checked')].map(cb => cb.dataset.id);
}

function updateBulkBar() {
  const checks   = [...el.historyList.querySelectorAll('.history-check')];
  const selected = checks.filter(c => c.checked);
  const count    = selected.length;

  el.bulkBar.hidden   = count === 0;
  el.bulkCount.textContent = `${count} selected`;
  el.selectAllCheck.checked       = count > 0 && count === checks.length;
  el.selectAllCheck.indeterminate = count > 0 && count < checks.length;

  el.historyList.querySelectorAll('.history-item').forEach(row => {
    row.classList.toggle('selected', row.querySelector('.history-check')?.checked ?? false);
  });
}

function _highlightSearch(html, q) {
  if (!q) return html;
  try {
    return html.replace(new RegExp(`(${_escapeRegex(escapeHtml(q))})`, 'gi'),
      '<mark class="search-hit">$1</mark>');
  } catch (_) { return html; }
}

function renderHistory(items, q = '') {
  el.historyList.innerHTML = '';
  el.bulkBar.hidden = true;

  if (!items.length) {
    el.historyList.appendChild(el.historyEmpty);
    el.historyEmpty.hidden = false;
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'history-item';
    const isComplete = item.status === 'completed';
    const playBtn = isComplete
      ? `<button class="hist-play" data-id="${item.id}" title="Play audio"><span class="hp-icon">▶</span> Play</button>`
      : '';
    const rerunBtn = isComplete
      ? `<button class="hist-retranscribe" data-id="${item.id}" title="Re-transcribe with different settings">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
           Re-run
         </button>`
      : '';
    const snippetHtml = item.snippet
      ? `<div class="history-snippet">"…${_highlightSearch(escapeHtml(item.snippet), q)}…"</div>` : '';

    div.innerHTML = `
      <label class="history-check-wrap" title="Select">
        <input type="checkbox" class="history-check" data-id="${item.id}">
      </label>
      <div class="history-icon">${getFileIcon(item.original_name)}</div>
      <div class="history-info">
        <div class="history-name-row">
          <div class="history-name">${_highlightSearch(escapeHtml(item.original_name), q)}</div>
          <button class="hist-rename" data-id="${item.id}" title="Rename">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
        <div class="history-sub">
          <span>${formatBytes(item.file_size)}</span>
          ${item.duration ? `<span>⏱ ${secondsToMMSS(item.duration)}</span>` : ''}
          <span>${new Date(item.created_at).toLocaleDateString()}</span>
        </div>
        ${snippetHtml}
      </div>
      <span class="history-badge badge-${item.status}">${item.status}</span>
      ${playBtn}
      ${rerunBtn}
      <button class="history-delete" data-id="${item.id}" title="Delete">🗑</button>
    `;

    div.querySelector('.history-check').addEventListener('change', updateBulkBar);

    // Rename
    div.querySelector('.hist-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      const nameEl = div.querySelector('.history-name');
      const input = document.createElement('input');
      input.className = 'rename-input';
      input.value = item.original_name;
      nameEl.replaceWith(input);
      input.focus(); input.select();

      let _renameCommitted = false;

      const commit = async () => {
        if (_renameCommitted) return;
        _renameCommitted = true;
        const newName = input.value.trim() || item.original_name;
        const restored = document.createElement('div');
        restored.className = 'history-name';
        restored.textContent = newName;
        input.replaceWith(restored);
        if (newName !== item.original_name) {
          try {
            await fetch(`/api/transcriptions/${item.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ original_name: newName }),
            });
            item.original_name = newName;
            const h = state.history.find(h => h.id === item.id);
            if (h) h.original_name = newName;
            showToast('Renamed', 'success');
          } catch {
            showToast('Rename failed', 'error');
          }
        }
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', ke => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') {
          _renameCommitted = true;
          const restored = document.createElement('div');
          restored.className = 'history-name';
          restored.textContent = item.original_name;
          input.replaceWith(restored);
        }
      });
    });

    if (isComplete) {
      div.querySelector('.history-info').addEventListener('click', (e) => {
        if (e.target.closest('.hist-rename') || e.target.tagName === 'INPUT') return;
        loadTranscription(item.id);
      });
      div.querySelector('.history-icon').addEventListener('click', () => loadTranscription(item.id));

      const hplay = div.querySelector('.hist-play');
      if (hplay) {
        hplay.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (player.txId === item.id) {
            playerToggle(item.id);
          } else {
            await loadTranscription(item.id);
            playerLoad(item.id);
            player.audio.play();
          }
        });
      }

      const hrerun = div.querySelector('.hist-retranscribe');
      if (hrerun) {
        hrerun.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const res = await fetch(`/api/transcriptions/${item.id}/retranscribe`, { method: 'POST' });
            if (!res.ok) throw new Error((await res.json()).detail || 'Failed');
            const { preprocess_id, original_name, duration_s } = await res.json();
            state.preprocessId  = preprocess_id;
            state.selectedFile  = { name: original_name };
            state.audioDuration = duration_s;
            _showOptionsAfterPreprocess(duration_s);
            showView('upload');
          } catch (err) {
            showToast('Re-transcribe failed: ' + err.message, 'error');
          }
        });
      }
    }

    div.querySelector('.history-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this transcription?')) return;
      if (player.txId === item.id) playerClose();
      await fetch(`/api/transcriptions/${item.id}`, { method: 'DELETE' });
      showToast('Deleted', 'info');
      refreshHistory(el.historySearch?.value?.trim() || '');
    });

    el.historyList.appendChild(div);
  });

  _syncHistoryPlayBtns();
}

el.historySearch?.addEventListener('input', () => {
  clearTimeout(el.historySearch._timer);
  el.historySearch._timer = setTimeout(() => {
    refreshHistory(el.historySearch.value.trim());
  }, 350);
});

el.bulkDeleteBtn.addEventListener('click', async () => {
  const ids = getSelectedIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} transcription${ids.length > 1 ? 's' : ''}?`)) return;
  await Promise.all(ids.map(id => fetch(`/api/transcriptions/${id}`, { method: 'DELETE' })));
  showToast(`Deleted ${ids.length} transcription${ids.length > 1 ? 's' : ''}`, 'info');
  refreshHistory(el.historySearch?.value?.trim() || '');
});

el.selectAllCheck.addEventListener('change', () => {
  el.historyList.querySelectorAll('.history-check').forEach(cb => {
    cb.checked = el.selectAllCheck.checked;
  });
  updateBulkBar();
});

// ─── Groq API Usage Bar ───────────────────────────────────────────────────────
function _usageFillClass(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return '';
}

function _resetLabel(resetStr, label) {
  if (!resetStr) return '';
  const asNum = Number(resetStr);
  if (!isNaN(asNum)) {
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
    if (!d.last_updated) return;

    el.usageEmpty.hidden = true;
    el.usageData.hidden  = false;

    if (d.requests_limit != null && d.requests_remaining != null) {
      const used = d.requests_limit - d.requests_remaining;
      const pct  = Math.min(100, Math.round(used / d.requests_limit * 100));
      el.ucReqNums.textContent = `${d.requests_remaining.toLocaleString()} / ${d.requests_limit.toLocaleString()} left`;
      el.ucReqFill.style.width = pct + '%';
      el.ucReqFill.className   = 'usage-fill ' + _usageFillClass(pct);
      el.ucReqMetric.hidden    = false;
    }

    if (d.tokens_limit != null && d.tokens_remaining != null) {
      const used = d.tokens_limit - d.tokens_remaining;
      const pct  = Math.min(100, Math.round(used / d.tokens_limit * 100));
      const fmt  = (s) => s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
      el.ucAudioNums.textContent = `${fmt(d.tokens_remaining)} / ${fmt(d.tokens_limit)} left`;
      el.ucAudioFill.style.width = pct + '%';
      el.ucAudioFill.className   = 'usage-fill ' + _usageFillClass(pct);
      el.ucAudioMetric.hidden    = false;
    }

    const resets = [
      _resetLabel(d.requests_reset, 'Daily quota'),
      _resetLabel(d.tokens_reset,   'Audio quota'),
    ].filter(Boolean);
    el.ucReset.textContent = resets[0] || '';
  } catch (_) {}
}

// ─── Engine (source) selector ─────────────────────────────────────────────────
function getSource() {
  return el.sourceOptions.querySelector('.source-btn.active')?.dataset.value || 'groq';
}

function updateUploadHint(src) {
  if (!el.uploadHint) return;
  el.uploadHint.textContent = src === 'openvino'
    ? 'MP3, MP4, WAV, M4A, WEBM, OGG, FLAC, MKV & more — no size limit'
    : 'MP3, MP4, WAV, M4A, WEBM, OGG, FLAC, MKV & more — long files split automatically';
}

function _syncUsageCard() {
  const usageCard = document.getElementById('usageCard');
  if (usageCard) usageCard.hidden = (getSource() === 'openvino');
}

function initSourceSelector() {
  el.sourceOptions.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.sourceOptions.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      btn.querySelector('input').checked = true;
      const src = btn.dataset.value;
      el.groqModelGroup.hidden = (src === 'openvino');
      el.ovModelGroup.hidden   = (src !== 'openvino');
      updateUploadHint(src);
      _syncUsageCard();
    });
  });
  _syncUsageCard(); // sync on page load based on which button starts active
}

// ─── Metadata (models + languages) ───────────────────────────────────────────
async function loadMeta() {
  try {
    const res = await fetch('/api/transcriptions/meta');
    if (!res.ok) return;
    const { models, languages, ov_models, ov_available } = await res.json();
    el.languageSelect.innerHTML = languages.map(l =>
      `<option value="${l.code}">${l.label}</option>`).join('');
    el.modelSelect.innerHTML = models.map(m =>
      `<option value="${m.id}">${m.label}</option>`).join('');
    if (ov_models?.length) {
      el.ovModelSelect.innerHTML = ov_models.map(m => {
        const cached = m.cached ? ' ✓ cached' : '';
        return `<option value="${m.id}">${m.label}${cached}</option>`;
      }).join('');
      el.ovModelSelect.value = 'small';
    }
    if (el.ovSourceBtn) {
      el.ovSourceBtn.title = ov_available
        ? 'Intel GPU via OpenVINO'
        : 'OpenVINO not installed — build with Dockerfile.openvino';
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
