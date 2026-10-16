const elements = Object.fromEntries(['count', 'count-caption', 'lecture-date', 'updated-at', 'refresh-status', 'refresh-text'].map(id => [id, document.getElementById(id)]));
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const updatedFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let refreshing = false;
let hasLoaded = false;
let endpoint = null;
let timer;
let failures = 0;
const observationIds = ['observed-change', 'observed-rate', 'observed-duration', 'observed-last-change', 'observation-note', 'activity-scale', 'activity-description'];
const observationElements = Object.fromEntries(observationIds.map(id => [id, document.getElementById(id)]));
const activityBars = Array.from({ length: 10 }, (_, i) => document.getElementById(`activity-bar-${i}`));
const receivedTimeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let observation = null;

function signed(value, decimals = 0) {
  return `${value > 0 ? '+' : ''}${value.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function observe(data) {
  // Public bootstrap data is not an observation. Only received published snapshots enter these statistics.
  if (data.count === null) { observation = null; renderObservation(); return; }
  const now = Date.now();
  if (!observation || observation.date !== data.lectureDate) {
    observation = { date: data.lectureDate, start: now, end: now, baseline: data.count, count: data.count, changes: [], lastChange: null, seenMinutes: new Set([Math.floor(now / 60000)]) };
  } else {
    const delta = data.count - observation.count;
    if (delta) {
      observation.changes.push({ time: now, delta });
      observation.lastChange = now;
    }
    observation.count = data.count;
    observation.end = now;
    observation.changes = observation.changes.filter(change => change.time >= now - 10 * 60 * 1000);
    observation.seenMinutes.add(Math.floor(now / 60000));
    observation.seenMinutes = new Set([...observation.seenMinutes].filter(minute => minute >= Math.floor(now / 60000) - 9));
  }
  renderObservation();
}

function renderObservation() {
  // The guard also permits a previously cached, count-only HTML page to use the updated script.
  if (observationIds.some(id => !observationElements[id]) || activityBars.some(bar => !bar)) return;
  const bins = new Array(10).fill(0);
  let minute = 0;
  if (!observation) {
    for (const id of ['observed-change', 'observed-rate', 'observed-duration', 'observed-last-change']) observationElements[id].textContent = '—';
    observationElements['observation-note'].textContent = 'Waiting for a published count. Opening this page does not reset the lecture counter.';
  } else {
    const seconds = Math.max(0, (observation.end - observation.start) / 1000);
    const delta = observation.count - observation.baseline;
    observationElements['observed-change'].textContent = signed(delta);
    observationElements['observed-rate'].textContent = seconds >= 30 ? signed(delta / (seconds / 60), 1) : '—';
    observationElements['observed-duration'].textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    observationElements['observed-last-change'].textContent = observation.lastChange === null ? 'Not yet' : receivedTimeFormat.format(new Date(observation.lastChange));
    observationElements['observation-note'].textContent = `Observing since ${receivedTimeFormat.format(new Date(observation.start))} Berlin time. Changes are net updates, including manual corrections; the lecture may have started earlier.`;
    minute = Math.floor(observation.end / 60000);
    for (const change of observation.changes) {
      const bin = Math.floor(change.time / 60000) - minute + 9;
      if (bin >= 0 && bin < 10) bins[bin] += change.delta;
    }
  }
  const max = Math.max(1, ...bins.map(value => Math.abs(value)));
  for (let index = 0; index < 10; index++) {
    const bar = activityBars[index];
    const delta = bins[index];
    const height = delta ? Math.abs(delta) / max * 60 : 2;
    const unobserved = !observation || !observation.seenMinutes.has(minute - 9 + index);
    bar.setAttribute('y', delta > 0 ? String(76 - height) : delta < 0 ? '76' : '74');
    bar.setAttribute('height', String(height));
    bar.classList.toggle('negative', delta < 0);
    bar.classList.toggle('unobserved', unobserved);
  }
  observationElements['activity-scale'].textContent = `NET CHANGE PER MINUTE · SCALE ${max}`;
  observationElements['activity-description'].textContent = observation ? `Net count changes received in the last ten calendar minutes, oldest first: ${bins.map(value => signed(value)).join(', ')}. Grey periods were not observed; values below zero are corrections.` : 'Waiting for published count updates. Grey periods have not been observed.';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validate(data, config = false) {
  if (!data || (config ? data.schemaVersion !== 1 : data.schemaVersion !== undefined && data.schemaVersion !== 1) || !validDate(data.lectureDate)) throw new Error('Invalid lecture update');
  if (data.count !== null && (!Number.isSafeInteger(data.count) || data.count < 0)) throw new Error('Invalid count');
  if (data.updatedAt !== null && (typeof data.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(data.updatedAt) || !Number.isFinite(Date.parse(data.updatedAt)))) throw new Error('Invalid update time');
  return data;
}

function liveEndpoint(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid live endpoint');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid live endpoint');
  return url;
}

function render(data) {
  const number = data.count === null ? '—' : data.count.toLocaleString('en-GB');
  if (elements.count.textContent !== number) elements.count.textContent = number;
  elements.count.setAttribute('aria-label', data.count === null ? 'No count published yet' : `${data.count.toLocaleString('en-GB')} ja occurrences`);
  elements.count.classList.toggle('is-medium', data.count !== null && String(data.count).length === 3);
  elements.count.classList.toggle('is-long', data.count !== null && String(data.count).length >= 4 && String(data.count).length < 7);
  elements.count.classList.toggle('is-very-long', data.count !== null && String(data.count).length >= 7);
  elements['count-caption'].textContent = data.count === null ? 'Waiting for the first update' : 'times “ja” was said.';
  elements['lecture-date'].dateTime = data.lectureDate;
  elements['lecture-date'].textContent = dateFormat.format(new Date(`${data.lectureDate}T12:00:00Z`));
  if (data.updatedAt === null) {
    elements['updated-at'].removeAttribute('datetime');
    elements['updated-at'].textContent = 'Not published yet';
  } else {
    elements['updated-at'].dateTime = data.updatedAt;
    elements['updated-at'].textContent = updatedFormat.format(new Date(data.updatedAt));
  }
}

function status(text, state) {
  if (elements['refresh-text'].textContent !== text) elements['refresh-text'].textContent = text;
  elements['refresh-status'].dataset.state = state;
}

async function request(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('t', String(Date.now()));
    const response = await fetch(requestUrl, { cache: 'no-store', signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`Update unavailable (${response.status})`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(refresh, delay);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  let delay = endpoint ? 1000 : 15000;
  try {
    if (endpoint) {
      const data = validate(await request(endpoint));
      render(data);
      observe(data);
      status(data.live === true ? 'Live from the lecture' : data.count === null ? 'Waiting for the lecture' : 'Latest lecture count', data.live === true ? 'live' : 'connected');
    } else {
      const data = validate(await request(new URL('./data/current.json', import.meta.url)), true);
      const configuredEndpoint = liveEndpoint(data.liveEndpoint);
      render(data);
      endpoint = configuredEndpoint;
      if (!endpoint) observe(data);
      status(endpoint ? 'Connecting to the lecture' : 'Updates automatically', endpoint ? 'checking' : 'connected');
      delay = endpoint ? 0 : 15000;
    }
    hasLoaded = true;
    failures = 0;
  } catch {
    status(hasLoaded ? 'Reconnecting… Last update kept' : 'Reconnecting…', 'reconnecting');
    delay = Math.min(10000, 2000 * 2 ** Math.min(failures++, 3));
  } finally {
    refreshing = false;
    schedule(delay);
  }
}

refresh();
document.addEventListener('visibilitychange', () => { if (!document.hidden && !refreshing) { clearTimeout(timer); refresh(); } });
