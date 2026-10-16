const elements = Object.fromEntries(['count', 'count-caption', 'lecture-date', 'updated-at', 'refresh-status', 'refresh-text'].map(id => [id, document.getElementById(id)]));
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const updatedFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
let refreshing = false;
let hasLoaded = false;
let endpoint = null;
let timer;
let failures = 0;

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
  let delay = endpoint ? 2000 : 15000;
  try {
    if (endpoint) {
      const data = validate(await request(endpoint));
      render(data);
      status(data.live === true ? 'Live from the lecture' : data.count === null ? 'Waiting for the lecture' : 'Latest lecture count', data.live === true ? 'live' : 'connected');
    } else {
      const data = validate(await request(new URL('./data/current.json', import.meta.url)), true);
      const configuredEndpoint = liveEndpoint(data.liveEndpoint);
      render(data);
      endpoint = configuredEndpoint;
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
