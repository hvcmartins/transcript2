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
  transcriptOrigin:       'upload',  // 'upload' | 'history'
  speakerMap:             {},        // original name → renamed value (cleared on load)
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
  selectedFileSize:     $('selectedFileSize'),
  clearFile:            $('clearFile'),
  languageSelect:       $('languageSelect'),
  modelSelect:          $('modelSelect'),
  groqModelGroup:       $('groqModelGroup'),
  ovModelGroup:         $('ovModelGroup'),
  ovModelSelect:        $('ovModelSelect'),
  ovSourceBtn:          $('ovSourceBtn'),
  sourceOptions:        $('sourceOptions'),
  uploadHint:           $('uploadHint'),
  customName:           $('customName'),
  customDesc:           $('customDesc'),
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
  cancelTranscribeBtn:  $('cancelTranscribeBtn'),
  metaFilename:         $('metaFilename'),
  metaDuration:         $('metaDuration'),
  metaLanguage:         $('metaLanguage'),
  metaDescription:      $('metaDescription'),
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
  ucModel:              $('ucModel'),
  ucRows:               $('ucRows'),
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
    if (msg.compressed_size) state.processedSize = msg.compressed_size;
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
  const sizeBytes = state.processedSize ?? state.selectedFile?.size ?? null;
  el.selectedFileSize.textContent = sizeBytes ? formatBytes(sizeBytes) : '';
  el.optionsPanel.querySelector('.file-icon').textContent =
    getFileIcon(state.selectedFile?.name || '');
  if (el.customName) el.customName.value = state.selectedFile?.name || '';
  if (el.customDesc) el.customDesc.value = '';
  el.dropZone.hidden = true;
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
  state.selectedFile   = null;
  state.preprocessId   = null;
  state.audioDuration  = null;
  state.processedSize  = null;
  el.dropZone.hidden      = false;
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

// ─── Client-side preprocessing ───────────────────────────────────────────────
const _MP4_EXTS = new Set(['mp4', 'm4a', 'm4v', 'mov']);

// Sample-rate → ADTS frequency index table (ISO 13818-7 Table 35)
const _ADTS_FREQ_IDX = {96000:0,88200:1,64000:2,48000:3,44100:4,32000:5,
                        24000:6,22050:7,16000:8,12000:9,11025:10,8000:11,7350:12};

function _adtsHeader(sampleRate, channels, frameDataBytes) {
  // 7-byte ADTS header, no CRC (protection_absent = 1)
  const freqIdx    = _ADTS_FREQ_IDX[sampleRate] ?? 4;   // 4 = 44100 Hz
  const profile    = 1;                                   // AAC-LC (objectType-1)
  const frameLen   = 7 + frameDataBytes;
  const h = new Uint8Array(7);
  h[0] =  0xFF;
  h[1] =  0xF1;                                          // MPEG-4, layer=00, no CRC
  h[2] = (profile << 6) | (freqIdx << 2) | ((channels >> 2) & 1);
  h[3] = ((channels & 3) << 6) | ((frameLen >> 11) & 3);
  h[4] =  (frameLen >> 3) & 0xFF;
  h[5] = ((frameLen  & 7) << 5) | 0x1F;
  h[6] =  0xFC;
  return h;
}

// Extract only the audio track from an MP4/M4A/MOV using mp4box.js.
// Reads the file in 2 MB slices — never loads the whole video into RAM.
// Returns a Blob of raw ADTS-AAC frames (a plain .aac bitstream ffmpeg reads natively).
async function _extractMp4Audio(file, onProgress) {
  if (typeof MP4Box === 'undefined') return null;

  return new Promise((resolve, reject) => {
    const mp4in   = MP4Box.createFile();
    let   audioId = null;
    let   totalSmp = 1, processedSmp = 0;
    let   sampleRate = 44100, channels = 2;
    const chunks  = [];   // alternating [adtsHeader, frameData, ...]
    let   done    = false;

    mp4in.onReady = (info) => {
      const track = (info.audioTracks || []).concat(
        (info.tracks || []).filter(t => t.type === 'audio')
      )[0];
      if (!track) { reject(new Error('No audio track')); return; }
      audioId    = track.id;
      totalSmp   = track.nb_samples || 1;
      sampleRate = track.audio?.sample_rate || 44100;
      channels   = track.audio?.channel_count || 2;
      mp4in.setExtractionOptions(audioId, null, { nbSamples: 1000 });
      mp4in.start();
    };

    mp4in.onSamples = (id, _user, samples) => {
      if (id !== audioId) return;
      for (const s of samples) {
        chunks.push(_adtsHeader(sampleRate, channels, s.data.byteLength));
        chunks.push(new Uint8Array(s.data));
        processedSmp++;
      }
      onProgress(30 + Math.round(processedSmp / totalSmp * 65), 'Extracting audio…');
    };

    mp4in.onError = (e) => { if (!done) reject(new Error('MP4Box: ' + e)); };

    (async () => {
      try {
        const CHUNK = 2 * 1024 * 1024;
        let offset = 0;
        while (offset < file.size) {
          const end = Math.min(offset + CHUNK, file.size);
          const buf = await file.slice(offset, end).arrayBuffer();
          buf.fileStart = offset;
          onProgress(Math.round(offset / file.size * 30), 'Parsing container…');
          const next = mp4in.appendBuffer(buf);
          offset = (typeof next === 'number' && next > offset) ? next : end;
        }
        mp4in.flush();          // delivers remaining onSamples synchronously
        await Promise.resolve();
        if (!done) {
          done = true;
          if (chunks.length === 0) { reject(new Error('No audio frames extracted')); return; }
          resolve(new Blob(chunks, { type: 'audio/aac' }));
        }
      } catch (e) {
        if (!done) reject(e);
      }
    })();
  });
}

let _ffmpegInst = null;
let _ffmpegBusy = false;

async function _ensureFfmpeg(onProgress) {
  if (_ffmpegInst?.isLoaded()) return _ffmpegInst;
  onProgress(0, 'Loading ffmpeg…');
  const { createFFmpeg } = window.FFmpeg;
  const inst = createFFmpeg({ log: false, corePath: '/js/ffmpeg/ffmpeg-core.js' });
  await inst.load();
  _ffmpegInst = inst;
  return _ffmpegInst;
}

async function _preprocessWithFfmpeg(file, onProgress) {
  if (_ffmpegBusy) return null;

  const ext         = file.name.split('.').pop().toLowerCase();
  const isMp4       = _MP4_EXTS.has(ext);
  // For non-MP4 formats we still need to load the whole file into WASM RAM
  if (!isMp4 && file.size > 500 * 1024 * 1024) return null;

  _ffmpegBusy = true;
  let inputName = isMp4 ? 'input.mp4' : ('input' + (file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''));

  try {
    const ff = await _ensureFfmpeg(onProgress);

    // --- For MP4/M4A/MOV: strip video first with mp4box.js ---
    let inputBlob = file;
    if (isMp4) {
      onProgress(5, 'Parsing container…');
      try {
        const audioOnly = await _extractMp4Audio(file, onProgress);
        if (audioOnly) {
          inputBlob = audioOnly;
          inputName  = 'input.aac';
          console.log(`[mp4box] ${formatBytes(file.size)} → ${formatBytes(audioOnly.size)} audio`);
        }
      } catch (e) {
        console.warn('[mp4box] extraction failed, passing full file:', e);
        if (file.size > 500 * 1024 * 1024) { return null; }  // too large for fallback
      }
    }

    if (state.selectedFile !== file) return null;

    ff.setProgress(({ ratio }) => {
      if (ratio > 0) onProgress(97 + Math.round(ratio * 2), 'Encoding MP3…');
    });

    onProgress(96, 'Encoding MP3…');
    const inputData = new Uint8Array(await inputBlob.arrayBuffer());
    if (state.selectedFile !== file) return null;

    for (const p of [inputName, 'output.mp3']) { try { ff.FS('unlink', p); } catch {} }
    ff.FS('writeFile', inputName, inputData);

    await ff.run('-i', inputName, '-vn', '-ar', '16000', '-ac', '1', '-ab', '32k', 'output.mp3');
    if (state.selectedFile !== file) return null;

    const data = ff.FS('readFile', 'output.mp3');
    return new Blob([data.buffer], { type: 'audio/mpeg' });

  } catch (err) {
    console.warn('[ffmpeg] encode failed, falling back to server:', err);
    return null;
  } finally {
    if (_ffmpegInst?.isLoaded()) {
      for (const p of [inputName, 'output.mp3']) { try { _ffmpegInst.FS('unlink', p); } catch {} }
    }
    _ffmpegBusy = false;
  }
}

async function handleFileSelected(file) {
  clearSelection();
  state.selectedFile = file;

  el.progressFilename.textContent = file.name;
  el.progressEta.textContent = '';
  el.progressPanel.hidden = false;
  el.phaseSection.hidden  = false;
  el.phaseBar.style.width = '0%';
  el.phasePct.textContent = '0%';

  let uploadFile = file;
  let clientPreprocessed = false;

  if (window.FFmpeg) {
    updateProgress(3, 'Preparing audio…', 'preprocess', 0);
    const mp3Blob = await _preprocessWithFfmpeg(file, (pct, label) => {
      updateProgress(3, label, 'preprocess', pct);
    });
    if (state.selectedFile !== file) return;  // file replaced while encoding
    if (mp3Blob) {
      const baseName = file.name.includes('.')
        ? file.name.slice(0, file.name.lastIndexOf('.')) + '.mp3'
        : file.name + '.mp3';
      uploadFile = new File([mp3Blob], baseName, { type: 'audio/mpeg' });
      state.processedSize = mp3Blob.size;
      clientPreprocessed = true;
      console.log(`[ffmpeg] ${formatBytes(file.size)} → ${formatBytes(mp3Blob.size)} MP3`);
    }
  }

  updateProgress(3, 'Uploading…', 'preprocess', clientPreprocessed ? 100 : 0);

  const formData = new FormData();
  formData.append('file', uploadFile);
  if (clientPreprocessed) formData.append('preprocessed', 'true');

  try {
    const res = await fetch('/api/transcriptions/preprocess', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Upload failed (${res.status})`);
    }
    const { preprocess_id } = await res.json();
    state.preprocessId = preprocess_id;

    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'register', sessionId: preprocess_id }));
    }

    if (!clientPreprocessed) {
      updateProgress(5, 'Preprocessing audio…', 'preprocess', 0);
    }

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
  if (el.customName?.value.trim()) formData.append('custom_name', el.customName.value.trim());
  if (el.customDesc?.value.trim()) formData.append('description',  el.customDesc.value.trim());

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

el.cancelTranscribeBtn?.addEventListener('click', async () => {
  if (!state.currentTranscriptionId) return;
  if (!confirm('Cancel this transcription?')) return;
  try {
    const res = await fetch(`/api/transcriptions/${state.currentTranscriptionId}/cancel`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Failed');
    stopPolling();
    state.transcriptionStartTime = null;
    state.currentTranscriptionId = null;
    el.progressPanel.hidden = true;
    el.phaseSection.hidden  = true;
    el.progressEta.textContent = '';
    el.dropZone.hidden = false;
    showToast('Transcription cancelled', 'info');
    refreshHistory();
  } catch (err) {
    showToast('Cancel failed: ' + err.message, 'error');
  }
});

function _reattachToTranscription(id, name, progress) {
  state.currentTranscriptionId = id;
  if (state.ws?.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'register', sessionId: id }));
  }
  startPolling(id);
  el.optionsPanel.hidden  = true;
  el.dropZone.hidden      = true;
  el.progressPanel.hidden = false;
  el.phaseSection.hidden  = true;
  if (el.progressFilename) el.progressFilename.textContent = name;
  updateProgress(progress || 10, 'Transcribing…', null, null);
  showView('upload');
}

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

async function loadTranscription(id, origin = 'upload') {
  state.transcriptOrigin = origin;
  state.speakerMap = {};
  try {
    const res = await fetch(`/api/transcriptions/${id}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();

    el.metaFilename.textContent = data.original_name;
    el.metaDuration.textContent = data.duration ? `⏱ ${secondsToMMSS(data.duration)}` : '';
    el.metaLanguage.textContent = (data.language && data.language !== 'auto')
      ? `🌐 ${data.language.toUpperCase()}` : '';
    if (el.metaDescription) el.metaDescription.textContent = data.description || '';

    el.segmentView.innerHTML = '';
    const segments    = data.segments || [];
    const words       = data.words    || [];
    const hasSpeakers = segments.some(s => s.speaker);
    const hasWords    = words.length > 0;
    // Confidence data is useful only when there is real per-segment variance.
    // Groq returns a constant avg_logprob (~-0.314) for all segments when it
    // doesn't compute per-segment scores — detect and treat that as no data.
    const logprobs = segments.map(s => s.avg_logprob).filter(v => v != null);
    const hasVaryingLogprob = logprobs.length > 0
      && !logprobs.every(v => Math.abs(v - logprobs[0]) < 0.001);
    const hasConfData = hasVaryingLogprob || words.some(w => w.probability != null);
    el.segmentView.dataset.hasConf = hasConfData ? 'true' : 'false';

    if (segments.length > 0) {
      let lastSpeaker = null;
      let wi = 0;

      segments.forEach((seg, segIdx) => {
        const div = document.createElement('div');
        div.className = 'segment';
        div.dataset.start = seg.start;
        div.dataset.end   = seg.end;

        // Paragraph break: speaker change or silence gap > 2 s between segments
        if (segIdx > 0) {
          const prev = segments[segIdx - 1];
          const speakerChanged = hasSpeakers && seg.speaker && seg.speaker !== prev.speaker;
          const silenceGap     = !hasSpeakers && (seg.start - prev.end) > 2.0;
          if (speakerChanged || silenceGap) div.classList.add('tx-para-break');
        }
        const segLp = seg.avg_logprob ?? null;
        if (segLp != null) div.dataset.conf = segLp < -1.0 ? 'low' : segLp < -0.5 ? 'mid' : 'high';
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
              if (w.probability < 0.50) confAttr = ' data-conf="low"';
              else if (w.probability < 0.75) confAttr = ' data-conf="mid"';
              else confAttr = ' data-conf="high"';
            } else if (segLogp != null) {
              if (segLogp < -1.0) confAttr = ' data-conf="low"';
              else if (segLogp < -0.5) confAttr = ' data-conf="mid"';
              else confAttr = ' data-conf="high"';
            }
            whtml += `<span class="word" data-s="${w.start}" data-e="${w.end}"${confAttr}>${escapeHtml(text)}</span>`;
            wordIdx++;
          }
          bodyHtml = whtml || `<span class="seg-text">${escapeHtml(seg.text.trim())}</span>`;
        } else {
          let segConf = '';
          const lp = seg.avg_logprob ?? null;
          if (lp != null) {
            if (lp < -1.0) segConf = ' data-conf="low"';
            else if (lp < -0.5) segConf = ' data-conf="mid"';
            else segConf = ' data-conf="high"';
          }
          bodyHtml = `<span class="seg-text"${segConf}>${escapeHtml(seg.text.trim())}</span>`;
        }

        if (hasSpeakers && seg.speaker) {
          const spkClass  = 'spk-' + seg.speaker.slice(-1).toLowerCase();
          const badgeHtml = seg.speaker !== lastSpeaker
            ? `<span class="seg-speaker ${spkClass}" data-original="${escapeHtml(seg.speaker)}">${escapeHtml(seg.speaker)}</span>` : '';
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

    // Cache word spans (and segment divs as fallback) for karaoke; wire up click-to-seek
    player.wordSpans    = Array.from(el.segmentView.querySelectorAll('.word[data-s]'));
    player.segmentDivs  = Array.from(el.segmentView.querySelectorAll('.segment[data-start]'));
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
    const confHasData = el.segmentView.dataset.hasConf === 'true';
    if (el.confToggleBtn) {
      el.confToggleBtn.classList.remove('conf-active');
      el.confToggleBtn.disabled = !confHasData;
      el.confToggleBtn.title = confHasData
        ? 'Show confidence highlighting'
        : 'Confidence highlighting not available — Groq does not expose per-segment scores. Use OpenVINO to get this feature.';
    }
    const confBanner = document.getElementById('confNoBanner');
    if (confBanner) confBanner.hidden = true;
    _syncEditBtn();
    playerLoad(id);
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

function _buildSpeakerPanel() {
  const panel = document.getElementById('speakerPanel');
  const rowsEl = document.getElementById('speakerRows');
  if (!panel || !rowsEl) return;

  const segments = state.currentData?.segments || [];
  const seen = new Set();
  const speakers = [];
  for (const seg of segments) {
    if (seg.speaker && !seen.has(seg.speaker)) { seen.add(seg.speaker); speakers.push(seg.speaker); }
  }
  if (speakers.length === 0) return;

  rowsEl.innerHTML = '';
  speakers.forEach(original => {
    const spkClass = 'spk-' + original.slice(-1).toLowerCase();
    const row = document.createElement('div');
    row.className = 'spk-row';
    row.innerHTML =
      `<span class="seg-speaker ${spkClass}">${escapeHtml(original)}</span>` +
      `<span class="spk-arrow">→</span>` +
      `<input class="spk-rename-input" type="text" placeholder="${escapeHtml(original)}" ` +
      `value="${escapeHtml(state.speakerMap[original] || '')}" data-original="${escapeHtml(original)}">`;
    rowsEl.appendChild(row);
    row.querySelector('.spk-rename-input').addEventListener('input', e => {
      const orig = e.target.dataset.original;
      state.speakerMap[orig] = e.target.value;
      const display = e.target.value.trim() || orig;
      el.segmentView.querySelectorAll('.seg-speaker').forEach(badge => {
        if (badge.dataset.original === orig) badge.textContent = display;
      });
    });
  });

  panel.hidden = false;
}

function _applySpeakerRenames() {
  if (!state.currentData?.segments) return;
  const map = state.speakerMap;
  const hasRenames = Object.values(map).some(v => v.trim());
  if (!hasRenames) return;

  // Commit renamed labels back into data-original so re-entry works correctly
  el.segmentView.querySelectorAll('.seg-speaker').forEach(badge => {
    const newName = (map[badge.dataset.original] || '').trim();
    if (newName) { badge.textContent = newName; badge.dataset.original = newName; }
  });

  state.currentData.segments = state.currentData.segments.map(seg => {
    const newName = (map[seg.speaker] || '').trim();
    return newName ? { ...seg, speaker: newName } : seg;
  });

  state.speakerMap = {};
}

function enterEditMode() {
  if (state.editMode) return;
  state.editMode = true;
  cancelAnimationFrame(player.rafId); // pause karaoke during editing
  el.segmentView.classList.add('edit-mode');

  el.segmentView.querySelectorAll('.seg-words, .seg-text').forEach(container => {
    // Replace inner spans with plain text so contenteditable is clean
    container.textContent = container.innerText;
    container.contentEditable = 'true';
    container.spellcheck = true;
    container.addEventListener('input', _onEditInput);
  });

  _buildSpeakerPanel();
  _syncEditBtn();
}

function exitEditMode() {
  if (!state.editMode) return;
  clearTimeout(state.saveTimer);
  state.editMode = false;
  el.segmentView.classList.remove('edit-mode');

  const containers = [...el.segmentView.querySelectorAll('[contenteditable="true"]')];

  // Capture edited text while still contenteditable, then rebuild HTML
  // to restore data-conf spans (stripped by enterEditMode).
  const editedTexts = containers.map(c => c.innerText.replace(/\n/g, ' ').trim());
  const hasWords = (state.currentData?.words || []).length > 0;

  containers.forEach((c, i) => {
    c.removeEventListener('input', _onEditInput);
    c.removeAttribute('contenteditable');
    c.removeAttribute('spellcheck');
    // Restore span structure so confidence highlighting works again
    const seg = (state.currentData?.segments || [])[i];
    const text = editedTexts[i] || seg?.text || '';
    if (!hasWords && seg) {
      const lp = seg.avg_logprob ?? null;
      const conf = lp == null ? '' : lp < -1.0 ? ' data-conf="low"' : lp < -0.5 ? ' data-conf="mid"' : ' data-conf="high"';
      c.innerHTML = `<span class="seg-text"${conf}>${escapeHtml(text)}</span>`;
    }
  });

  player.wordSpans = []; // spans were stripped; karaoke falls back to segment divs

  // Commit speaker renames into state before _flushEdits so they are included in the PATCH
  _applySpeakerRenames();
  const spkPanel = document.getElementById('speakerPanel');
  if (spkPanel) spkPanel.hidden = true;

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
  state.savePending = true;
  if (el.editToggleBtn.querySelector('.save-dot')) return;
  const dot = document.createElement('span');
  dot.className = 'save-dot';
  el.editToggleBtn.appendChild(dot);
}

function _removeSaveDot() {
  state.savePending = false;
  el.editToggleBtn.querySelector('.save-dot')?.remove();
}

window.addEventListener('beforeunload', e => {
  if (state.savePending) { e.preventDefault(); e.returnValue = ''; }
});

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
  const { ci } = _frMatches[_frCurrent];
  const c = containers[ci];
  if (!c) return;
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  c.classList.add('fr-highlight');
  setTimeout(() => c.classList.remove('fr-highlight'), 1500);
  // Note: we intentionally do NOT call window.getSelection() here because
  // creating a DOM text selection steals keyboard focus from the search input,
  // causing the "one character at a time" typing bug.
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
  if (el.confToggleBtn.disabled) return;
  _confMode = !_confMode;
  el.segmentView.classList.toggle('conf-mode', _confMode);
  el.confToggleBtn.classList.toggle('conf-active', _confMode);
  el.confToggleBtn.title = _confMode ? 'Hide confidence highlighting' : 'Show confidence highlighting';
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

  // Lazily refresh word spans (only when actually empty, e.g. after transcript load)
  if (player.wordSpans.length === 0 && player.txId === state.currentTranscriptionId) {
    player.wordSpans = Array.from(el.segmentView.querySelectorAll('.word[data-s]'));
  }

  // Use word spans when available; fall back to segment divs (OpenVINO / post-edit mode)
  const useSegments = player.wordSpans.length === 0;
  const spans = useSegments ? player.segmentDivs : player.wordSpans;

  const t = player.audio.currentTime;

  // Binary search: last element whose start ≤ t
  let lo = 0, hi = spans.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = parseFloat(useSegments ? spans[mid].dataset.start : spans[mid].dataset.s);
    if (start <= t) { found = mid; lo = mid + 1; }
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
el.backBtn.addEventListener('click', () => { exitEditMode(); showView(state.transcriptOrigin || 'upload'); });

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

function _buildHistoryItem(item, q) {
  const div = document.createElement('div');
  div.className = 'history-item';
  const isComplete   = item.status === 'completed';
  const isProcessing = item.status === 'processing' || item.status === 'pending';
  const playBtn = isComplete
    ? `<button class="hist-play" data-id="${item.id}" title="Play audio"><span class="hp-icon">▶</span> Play</button>`
    : '';
  const rerunBtn = isComplete
    ? `<button class="hist-retranscribe" data-id="${item.id}" title="Re-transcribe with different settings">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
         Re-run
       </button>`
    : '';
  const descHtml = item.description
    ? `<div class="history-desc">${escapeHtml(item.description)}</div>` : '';
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
      ${descHtml}
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
      loadTranscription(item.id, 'history');
    });
    div.querySelector('.history-icon').addEventListener('click', () => loadTranscription(item.id, 'history'));

    const hplay = div.querySelector('.hist-play');
    if (hplay) {
      hplay.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (player.txId === item.id) {
          playerToggle(item.id);
        } else {
          await loadTranscription(item.id, 'history');
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

  if (isProcessing) {
    div.querySelector('.history-info').addEventListener('click', (e) => {
      if (e.target.closest('.hist-rename') || e.target.tagName === 'INPUT') return;
      _reattachToTranscription(item.id, item.original_name, item.progress || 0);
    });
  }

  div.querySelector('.history-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this transcription?')) return;
    if (player.txId === item.id) playerClose();
    await fetch(`/api/transcriptions/${item.id}`, { method: 'DELETE' });
    showToast('Deleted', 'info');
    refreshHistory(el.historySearch?.value?.trim() || '');
  });

  return div;
}

const _HISTORY_PAGE = 60;

function _appendHistoryChunk(items, offset, q) {
  el.historyList.querySelector('.history-sentinel')?.remove();
  const chunk = items.slice(offset, offset + _HISTORY_PAGE);
  chunk.forEach(item => el.historyList.appendChild(_buildHistoryItem(item, q)));
  _syncHistoryPlayBtns();

  if (offset + _HISTORY_PAGE < items.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'history-sentinel';
    el.historyList.appendChild(sentinel);
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) { obs.disconnect(); _appendHistoryChunk(items, offset + _HISTORY_PAGE, q); }
    }, { rootMargin: '200px' });
    obs.observe(sentinel);
  }
}

function renderHistory(items, q = '') {
  el.historyList.innerHTML = '';
  el.bulkBar.hidden = true;

  if (!items.length) {
    el.historyList.appendChild(el.historyEmpty);
    el.historyEmpty.hidden = false;
    return;
  }

  _appendHistoryChunk(items, 0, q);
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

function _fmtSeconds(s) {
  if (s == null) return '—';
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
  if (s >= 60)   return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

function _ucBar(used, limit) {
  if (limit == null || limit === 0) return 0;
  return Math.min(100, Math.round((used ?? 0) / limit * 100));
}

function _ucRow(label, window, used, limit, reset, fmtFn) {
  const fmt = fmtFn || ((n) => n == null ? '—' : n.toLocaleString());
  const pct = _ucBar(used, limit);
  const cls = _usageFillClass(pct);
  const resetTxt = reset ? _resetLabel(reset, 'Resets') : '';
  return `<div class="uc-row">
    <div class="uc-row-head">
      <span class="uc-label">${label}</span>
      <span class="uc-window">${window || ''}</span>
      <span class="uc-nums">${fmt(used)} / ${fmt(limit)}</span>
    </div>
    <div class="usage-bar"><div class="usage-fill ${cls}" style="width:${pct}%"></div></div>
    ${resetTxt ? `<div class="uc-reset">${resetTxt}</div>` : ''}
  </div>`;
}

async function loadUsage() {
  try {
    const res = await fetch('/api/usage');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.last_updated) return;

    el.usageEmpty.hidden = true;
    el.usageData.hidden  = false;

    el.ucModel.textContent = d.model || '';
    el.ucModel.hidden = !d.model;

    const rows = [];

    if (d.requests_limit != null) {
      rows.push(_ucRow('Requests', d.requests_window, d.requests_used, d.requests_limit, d.requests_reset));
    }
    if (d.audio_limit != null) {
      rows.push(_ucRow('Audio Seconds', d.audio_window, d.audio_used, d.audio_limit, d.audio_reset, _fmtSeconds));
    }
    if (d.tokens_limit != null) {
      rows.push(_ucRow('Tokens', d.tokens_window, d.tokens_used, d.tokens_limit, d.tokens_reset));
    }

    el.ucRows.innerHTML = rows.join('');
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
    const { models, languages, ov_models, ov_available, groq_key_set } = await res.json();
    if (groq_key_set === false) {
      const groqBtn = document.querySelector('.source-btn[data-value="groq"]');
      if (groqBtn) { groqBtn.title = 'GROQ_API_KEY is not set — Groq transcription will fail'; groqBtn.style.opacity = '0.45'; }
    }
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
