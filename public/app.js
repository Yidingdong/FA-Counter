import { getMatches, extractChunk, formatTime, histogram, buildCsv, wordFrequency, findTokens } from './core.mjs';
import { MicrophoneCapture, decodeFile, fileChunk, CHUNK_SECONDS, OVERLAP_SECONDS } from './audio.mjs';

const $ = id => document.getElementById(id);
const state = {
  words: [], excluded: new Set(), adjustment: 0, duration: 0, key: '', serverKey: false, local: false,
  language: 'auto', mode: 'live', capture: null, queue: [], processing: false, paused: false,
  fileTask: null, fileActive: false, preparing: false, starting: false, stopping: false, controller: null, generation: 0, sequence: 0, demo: false, elapsedBase: 0, started: 0,
};
const busy = () => !!(state.capture || state.processing || state.fileActive || state.preparing || state.stopping || state.queue.length);
const options = () => ({ includeVariants: $('include-variants').checked, endOnly: $('end-only').checked });
const matches = () => getMatches(state.words, options()).filter(match => !state.excluded.has(match.id));
const transcript = () => state.words.map(word => word.word.trim()).join(' ');

function status(text, active = false) {
  $('status-text').textContent = text;
  $('status-dot').classList.toggle('active', active);
  document.body.classList.toggle('is-recording', !!state.capture);
}

function showError(message, retry = false) {
  $('error-message').textContent = message;
  $('error-banner').hidden = false;
  $('retry-btn').hidden = !retry;
}
function clearError() { $('error-banner').hidden = true; }

function updateControls() {
  const active = busy();
  $('start-btn').disabled = active;
  $('stop-btn').disabled = !state.capture || state.starting;
  $('analyze-btn').disabled = active && !state.fileActive;
  $('analyze-btn').textContent = state.fileActive ? 'Cancel analysis' : 'Analyze recording';
  for (const id of ['mode-live', 'mode-file', 'mic-select', 'file-input', 'demo-btn']) $(id).disabled = active;
  $('reset-btn').disabled = active && !state.paused;
  $('export-btn').disabled = !state.words.length && !state.adjustment;
  $('settings-btn').disabled = active && !state.paused;
}

function make(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function highlighted(text) {
  const fragment = document.createDocumentFragment();
  let previous = 0;
  for (const token of findTokens(text, $('include-variants').checked)) {
    fragment.append(document.createTextNode(text.slice(previous, token.index)));
    fragment.append(make('mark', '', text.slice(token.index, token.index + token.length)));
    previous = token.index + token.length;
  }
  fragment.append(document.createTextNode(text.slice(previous)));
  return fragment;
}

function renderWords() {
  const frequency = wordFrequency(state.words);
  $('word-total').textContent = frequency.total.toLocaleString();
  $('unique-words').textContent = `${frequency.unique.toLocaleString()} unique words`;
  const query = $('word-search').value.trim().toLocaleLowerCase();
  let entries = frequency.entries.filter(entry => entry.word.includes(query));
  if ($('word-sort').value === 'alphabetical') entries.sort((a, b) => a.word.localeCompare(b.word));
  const rows = entries.map((entry, index) => {
    const row = make('tr');
    row.append(make('td', 'word-rank', String(index + 1).padStart(2, '0')), make('td', 'frequency-word', entry.word),
      make('td', 'frequency-count', entry.count.toLocaleString()),
      make('td', 'frequency-share', `${(entry.count / frequency.total * 100).toFixed(1)}%`));
    return row;
  });
  $('word-table').replaceChildren(...rows);
  $('word-empty').hidden = !!entries.length;
  $('word-empty').textContent = query ? 'No words match your search.' : 'Every word will appear here as the lecture unfolds.';
}

function render() {
  const found = matches();
  const count = Math.max(0, found.length + state.adjustment);
  $('count').textContent = count.toLocaleString();
  $('rate').textContent = state.duration > 0 ? (count / (state.duration / 60)).toFixed(1) : '0.0';
  $('elapsed').textContent = formatTime(state.duration);
  $('last-ja').textContent = found.length ? formatTime(found.at(-1).start) : '—';
  $('match-count').textContent = `${found.length} match${found.length === 1 ? '' : 'es'}${state.adjustment ? ` · ${state.adjustment > 0 ? '+' : ''}${state.adjustment} manual` : ''}`;
  $('count').setAttribute('aria-label', `${count} ja occurrences${state.demo ? ', sample demo' : ''}`);

  const transcriptRows = [];
  for (let i = 0; i < state.words.length; i += 35) {
    const row = make('div', 'transcript-row');
    const text = make('p', 'transcript-text');
    text.append(highlighted(state.words.slice(i, i + 35).map(w => w.word.trim()).join(' ')));
    row.append(make('span', 'timestamp', formatTime(state.words[i].start)), text);
    transcriptRows.push(row);
  }
  if (!transcriptRows.length) transcriptRows.push(make('div', 'empty-state', 'Your lecture, word for word. Start listening or upload a recording to see the transcript here.'));
  if (state.demo) transcriptRows.unshift(make('span', 'demo-badge', 'SAMPLE DEMO · NO AUDIO TRANSCRIBED'));
  $('transcript').replaceChildren(...transcriptRows);

  const detections = found.slice(-100).reverse().map(match => {
    const row = make('div', 'detection');
    const text = make('p', 'detection-context'); text.append(highlighted(match.context));
    const button = make('button', 'detection-remove', '×');
    button.type = 'button'; button.title = 'Exclude this match'; button.setAttribute('aria-label', `Exclude ${match.word} at ${formatTime(match.start)}`);
    button.addEventListener('click', () => { state.excluded.add(match.id); render(); });
    row.append(make('span', 'detection-time', `${match.approximate ? '~' : ''}${formatTime(match.start)}`), text, button);
    return row;
  });
  if (!detections.length) detections.push(make('div', 'empty-state', 'The next “ja” has a place right here.'));
  $('detections').replaceChildren(...detections);

  const bins = histogram(found, state.duration);
  const max = Math.max(1, ...bins);
  const bars = bins.map((value, index) => {
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('x', index * 20 + 2); bar.setAttribute('y', 96 - value / max * 86);
    bar.setAttribute('width', 14); bar.setAttribute('height', Math.max(2, value / max * 86));
    bar.setAttribute('rx', 3); bar.setAttribute('fill', value ? '#d4ee80' : '#3d413d');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${formatTime(index * state.duration / 30)}: ${value} ja`; bar.append(title);
    return bar;
  });
  $('chart').replaceChildren(...bars);
  $('chart-empty').hidden = !!found.length;
  renderWords(); updateControls();
}

function ensureKey() {
  if (state.key || state.serverKey) return true;
  $('key-status').textContent = 'Add your OpenAI API key to start counting.';
  $('settings-dialog').showModal(); $('api-key').focus();
  return false;
}

async function transcribe(chunk) {
  const form = new FormData();
  form.append('file', chunk.blob, 'lecture.wav');
  if (state.language !== 'auto') form.append('language', state.language);
  if (!state.local) {
    form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word'); form.append('timestamp_granularities[]', 'segment');
    form.append('temperature', '0');
    form.append('prompt', 'An English university lecture in Germany. So this is the result, ja. We can see the relationship, ja? Um, ja, let us continue.');
  }
  const controller = new AbortController();
  state.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(state.local ? './api/transcribe' : 'https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', body: form, headers: state.key ? { Authorization: `Bearer ${state.key}` } : {}, signal: controller.signal,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Transcription returned an unreadable response (${response.status}).`); }
    if (!response.ok) {
      if (response.status === 401) throw new Error('The API key was not accepted. Open settings and check your key, then retry.');
      if (response.status === 429) throw new Error('OpenAI reports a rate limit or exhausted API credit. Check your billing, then retry.');
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new Error(message || `Transcription failed (${response.status}).`);
    }
    if (!Array.isArray(data.words) && !Array.isArray(data.segments)) throw new Error('Whisper returned no word or segment timestamps. Please retry this audio window.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Transcription was cancelled or timed out. You can retry the saved audio window.');
    if (error instanceof TypeError) throw new Error('Could not reach OpenAI. Check your internet connection, then retry.');
    throw error;
  } finally { clearTimeout(timeout); if (state.controller === controller) state.controller = null; }
}

function accept(data, chunk) {
  state.words.push(...extractChunk(data, { ...chunk, id: `chunk-${state.sequence++}` }));
  state.words.sort((a, b) => a.start - b.start);
  state.duration = Math.max(state.duration, chunk.end);
}

async function pump() {
  if (state.processing || state.paused) return;
  const generation = state.generation;
  state.processing = true; updateControls();
  try {
    while (generation === state.generation) {
      if (!state.queue.length && state.fileTask) {
        const task = state.fileTask;
        const chunk = fileChunk(task.buffer, task.offset, task.base);
        state.queue.push(chunk);
        task.offset += CHUNK_SECONDS - OVERLAP_SECONDS;
        if (chunk.final) state.fileTask = null;
      }
      if (!state.queue.length) break;
      const chunk = state.queue[0];
      if (chunk.silent) state.duration = Math.max(state.duration, chunk.end);
      else {
        status(state.capture ? `Listening · ${state.queue.length} window${state.queue.length === 1 ? '' : 's'} processing` : 'Transcribing audio…', !!state.capture);
        const data = await transcribe(chunk);
        if (generation !== state.generation) return;
        accept(data, chunk);
      }
      state.queue.shift(); render();
      if (state.fileTotal) {
        const percent = Math.min(100, (chunk.end - state.fileBase) / state.fileTotal * 100);
        $('progress').value = percent; $('progress-label').textContent = `${Math.round(percent)}% · ${formatTime(chunk.end - state.fileBase)} / ${formatTime(state.fileTotal)}`;
      }
    }
  } catch (error) {
    if (generation !== state.generation) return;
    state.paused = true;
    if (state.capture) {
      const capture = state.capture; state.capture = null; state.stopping = true;
      try { await capture.stop(); } finally { state.stopping = false; }
      $('level-meter').style.transform = 'scaleX(0)'; $('level-meter').setAttribute('aria-valuenow', '0');
    }
    if (generation !== state.generation) return;
    showError(`${error.message} Your pending audio is kept in this tab.`, true);
    status('Paused · action needed');
  } finally {
    if (generation === state.generation) {
      state.processing = false;
      if (!state.fileTask && !state.queue.length && !state.paused) state.fileActive = false;
      if (!state.paused) status(state.capture ? 'Listening · waiting for next window' : 'Session ready', !!state.capture);
      if (!state.capture && !state.fileTask && !state.queue.length) $('progress-wrap').hidden = true;
      updateControls();
    }
  }
}

function enqueue(chunk) {
  state.queue.push(chunk);
  if (state.queue.length > 20 && state.capture) {
    stopListening();
    showError('Transcription is falling behind. Recording stopped so the queued audio can finish.');
  }
  pump();
}

async function startListening() {
  if (busy() || !ensureKey()) return;
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) {
    showError('Live listening needs a current Chrome, Edge, Firefox, or Safari browser on HTTPS or localhost.'); return;
  }
  if (state.demo) reset();
  clearError(); state.paused = false;
  state.elapsedBase = state.duration; state.starting = true;
  const generation = state.generation;
  const base = state.duration;
  const capture = new MicrophoneCapture({ onChunk: chunk => {
    if (generation === state.generation) enqueue({ ...chunk, offset: chunk.offset + base,
      from: chunk.from + base, to: chunk.to + base, end: chunk.end + base });
  }, onLevel: level => {
    if (generation !== state.generation) return;
    $('level-meter').style.transform = `scaleX(${level})`; $('level-meter').setAttribute('aria-valuenow', String(Math.round(level * 100)));
  } });
  state.capture = capture; status('Requesting microphone…'); updateControls();
  try {
    await capture.start($('mic-select').value);
    if (generation !== state.generation || state.capture !== capture) { await capture.dispose(); return; }
    state.starting = false; state.started = performance.now(); updateControls();
    status('Listening · first update in about 12 seconds', true);
    capture.stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (state.capture === capture) { stopListening(); showError('Your microphone disconnected. Reconnect it to continue this session.'); } });
    await listMicrophones();
  } catch (error) {
    state.capture = null; state.starting = false;
    showError(error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow microphone access in your browser and try again.' : `Could not start the microphone: ${error.message}`);
    status('Microphone unavailable'); updateControls();
  }
}

async function stopListening() {
  if (!state.capture || state.starting) return;
  const capture = state.capture; state.capture = null; state.stopping = true;
  $('stop-btn').disabled = true; status('Finishing the last audio window…');
  try { await capture.stop(); } finally { state.stopping = false; }
  $('level-meter').style.transform = 'scaleX(0)'; $('level-meter').setAttribute('aria-valuenow', '0');
  if (!state.processing && !state.paused) status('Session ready');
  render();
}

async function analyzeFile() {
  if (state.fileActive) {
    state.generation++; state.controller?.abort(); state.fileTask = null; state.fileActive = false; state.preparing = false; state.queue = []; state.processing = false; state.paused = false;
    $('progress-wrap').hidden = true; status('Analysis cancelled · partial results kept'); updateControls(); return;
  }
  if (busy() || !ensureKey()) return;
  const file = $('file-input').files[0];
  if (!file) { showError('Choose an audio recording first.'); return; }
  if (state.demo) reset();
  clearError(); state.preparing = true; state.fileActive = true; status('Preparing the recording…'); updateControls();
  const generation = state.generation;
  try {
    const buffer = await decodeFile(file);
    if (generation !== state.generation) return;
    state.preparing = false;
    state.fileTotal = buffer.duration; state.fileBase = state.duration;
    state.fileTask = { buffer, offset: 0, base: state.duration }; state.paused = false;
    $('progress-wrap').hidden = false; $('progress').value = 0;
    $('progress-label').textContent = `0% · 00:00 / ${formatTime(buffer.duration)}`;
    if ($('session-title').value === 'Untitled lecture') $('session-title').value = file.name.replace(/\.[^.]+$/, '');
    pump(); updateControls();
  } catch (error) { if (generation !== state.generation) return; state.preparing = false; state.fileActive = false; showError(error.message); status('Could not read recording'); updateControls(); }
}

async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const previous = $('mic-select').value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    const items = devices.map((device, index) => { const option = make('option', '', device.label || `Microphone ${index + 1}`); option.value = device.deviceId; return option; });
    if (items.length) { $('mic-select').replaceChildren(...items); if (devices.some(device => device.deviceId === previous)) $('mic-select').value = previous; }
  } catch { /* The default microphone remains available even before permission. */ }
}

function reset() {
  if (busy() && !state.paused) return;
  state.generation++; state.controller?.abort(); state.queue = []; state.fileTask = null; state.fileActive = false; state.processing = false;
  state.words = []; state.excluded.clear(); state.adjustment = 0; state.duration = 0;
  state.demo = false; state.fileTotal = 0; state.paused = false; clearError();
  status('Ready when you are'); render();
}

function demo() {
  if (busy()) return;
  reset(); state.demo = true;
  const text = 'So if we look at the equation, ja. The derivative tells us how quickly the function changes, ja? And this is the important part. We take the limit as h approaches zero, ja. The function is continuous here, but continuity alone is not enough, ja. We need the derivative to exist. So let us work through another example, ja?';
  state.words = text.split(/\s+/).map((word, index) => ({ word, start: index * 0.7, end: index * 0.7 + 0.3, id: `demo-${index}` }));
  state.duration = 48; status('Sample demo · no microphone or API used'); render();
}

function exportSession() {
  const csv = buildCsv({ title: $('session-title').value.trim() || 'Untitled lecture', matches: matches(), adjustment: state.adjustment,
    duration: state.duration, transcript: transcript(), demo: state.demo, words: state.words });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = make('a'); link.href = url; link.download = `ja-counter-${new Date().toISOString().slice(0, 10)}${state.demo ? '-demo' : ''}.csv`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function selectMode(mode) {
  if (busy()) return;
  state.mode = mode;
  $('live-controls').hidden = mode !== 'live'; $('file-controls').hidden = mode !== 'file';
  for (const name of ['live', 'file']) { $(`mode-${name}`).setAttribute('aria-selected', String(name === mode)); $(`mode-${name}`).classList.toggle('active', name === mode); }
}

$('mode-live').addEventListener('click', () => selectMode('live'));
$('mode-file').addEventListener('click', () => selectMode('file'));
$('start-btn').addEventListener('click', startListening);
$('stop-btn').addEventListener('click', stopListening);
$('analyze-btn').addEventListener('click', analyzeFile);
$('file-input').addEventListener('change', () => { $('file-label').textContent = $('file-input').files[0]?.name || 'Choose a recording'; });
$('retry-btn').addEventListener('click', () => { if (!ensureKey()) return; clearError(); state.paused = false; pump(); });
$('reset-btn').addEventListener('click', reset);
$('demo-btn').addEventListener('click', demo);
$('export-btn').addEventListener('click', exportSession);
$('include-variants').addEventListener('change', render);
$('end-only').addEventListener('change', render);
$('word-search').addEventListener('input', renderWords);
$('word-sort').addEventListener('change', renderWords);
$('adjust-plus').addEventListener('click', () => { state.adjustment++; render(); });
$('adjust-minus').addEventListener('click', () => { if (matches().length + state.adjustment > 0) state.adjustment--; render(); });
$('settings-btn').addEventListener('click', () => { $('api-key').value = state.key; $('settings-dialog').showModal(); });
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-form').addEventListener('submit', event => {
  event.preventDefault(); state.key = $('api-key').value.trim(); state.language = $('language-select').value;
  $('api-key').value = '';
  $('key-status').textContent = state.key ? 'Key set for this tab. It will be forgotten when the page closes.' : state.serverKey ? 'Using the local server API key.' : 'No API key configured.';
  $('settings-dialog').close();
});

window.addEventListener('beforeunload', event => { if (busy()) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.capture) status('Listening · keep this tab open for reliable capture', true);
  else if (state.capture) status('Listening · updates every 12 seconds', true);
});
setInterval(() => { if (state.capture && !state.starting) $('elapsed').textContent = formatTime(state.elapsedBase + (performance.now() - state.started) / 1000); }, 500);

async function init() {
  render(); await listMicrophones();
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try {
      const response = await fetch('./api/status');
      const data = await response.json();
      if (data.model === 'whisper-1') { state.local = true; state.serverKey = data.hasApiKey; }
    } catch { /* A plain static local preview uses direct OpenAI requests. */ }
  }
  $('key-status').textContent = state.serverKey ? 'Using the local server API key.' : 'Your key stays in this tab’s memory. Audio goes directly to OpenAI on GitHub Pages.';
}
init();
