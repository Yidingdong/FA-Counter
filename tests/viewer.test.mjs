import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';

const publicRoot = new URL('../public/', import.meta.url);
const viewerUrl = new URL('viewer.js', publicRoot);
const viewerSource = await readFile(viewerUrl, 'utf8');
const LIVE_URL = 'https://ja-lecture-count-relay.shrewdhare17.chatgpt.site/api/count';
const unpublished = () => ({ schemaVersion: 1, count: null, lectureDate: '2026-10-16', updatedAt: null });
const update = (count, extra = {}) => ({ schemaVersion: 1, count, lectureDate: '2026-10-16',
  updatedAt: '2026-10-16T10:30:00.000Z', live: true, ...extra });

class Element {
  textContent = '';
  dataset = {};
  attributes = new Map();
  classes = new Set();
  classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

async function viewer(responses) {
  const ids = ['count', 'count-caption', 'lecture-date', 'updated-at', 'refresh-status', 'refresh-text', 'observed-change', 'observed-rate', 'observed-duration', 'observed-last-change', 'observation-note', 'activity-scale', 'activity-description', ...Array.from({ length: 10 }, (_, i) => `activity-bar-${i}`)];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const timers = new Map(), calls = [], listeners = new Map();
  let nextTimer = 0;
  const document = { hidden: false, getElementById: id => elements[id],
    addEventListener: (name, callback) => listeners.set(name, callback) };
  let now = Date.parse('2026-10-16T10:30:00.000Z');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ document, URL, Intl, Date: ClockDate, AbortController,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      calls.push({ url: new URL(url), options });
      assert.ok(responses.length, 'the viewer made an unexpected network request');
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, json: async () => value };
    },
  });
  // The actual browser script is evaluated unchanged except for ESM metadata supplied by the VM.
  new vm.Script(viewerSource.replaceAll('import.meta.url', JSON.stringify('https://yidingdong.github.io/ja-counter/viewer.js')),
    { filename: 'public/viewer.js' }).runInContext(context);
  await setImmediate();
  return { elements, calls, document, listeners,
    advance(milliseconds) { now += milliseconds; },
    delay() {
      assert.equal(timers.size, 1, 'only the next refresh timer should remain after a completed request');
      return [...timers.values()][0].delay;
    },
    async step(expectedDelay) {
      assert.equal(timers.size, 1);
      const [id, task] = [...timers][0];
      if (expectedDelay !== undefined) assert.equal(task.delay, expectedDelay);
      timers.delete(id);
      now += task.delay;
      await task.callback();
      await setImmediate();
    },
  };
}

test('unpublished null and a genuine zero display differently', async () => {
  const page = await viewer([unpublished(), update(0, { live: false })]);
  assert.equal(page.elements.count.textContent, '—');
  assert.equal(page.elements.count.attributes.get('aria-label'), 'No count published yet');
  assert.equal(page.elements['count-caption'].textContent, 'Waiting for the first update');
  assert.equal(page.elements['updated-at'].textContent, 'Not published yet');
  assert.equal(page.delay(), 15000);
  await page.step(15000);
  assert.equal(page.elements.count.textContent, '0');
  assert.equal(page.elements.count.attributes.get('aria-label'), '0 ja occurrences');
  assert.equal(page.elements['count-caption'].textContent, 'times “ja” was said.');
  assert.equal(page.elements['lecture-date'].dateTime, '2026-10-16');
  assert.equal(page.elements['updated-at'].dateTime, '2026-10-16T10:30:00.000Z');
});

test('bootstrap selects the relay then polls at one second and displays live updates', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(41), update(42)]);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url.pathname, '/ja-counter/data/current.json');
  assert.equal(page.delay(), 0);
  await page.step(0);
  assert.equal(page.calls[1].url.origin + page.calls[1].url.pathname, LIVE_URL);
  assert.ok(page.calls[1].url.searchParams.has('t'));
  assert.equal(page.elements.count.textContent, '41');
  assert.equal(page.elements['refresh-status'].dataset.state, 'live');
  assert.equal(page.delay(), 1000);
  await page.step(1000);
  assert.equal(page.elements.count.textContent, '42');
  assert.equal(page.delay(), 1000);
  for (const call of page.calls) {
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(call.options.headers, undefined, 'public requests must not contain publishing or OpenAI credentials');
  }
});

test('malformed updates preserve the last count and arbitrary fields are never rendered or forwarded', async () => {
  const privateValue = 'this-value-must-not-appear-in-the-public-dom';
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(41), update(-1),
    update(42, { apiKey: privateValue, transcript: privateValue, liveEndpoint: 'https://untrusted.example/steal' }),
    update(99, { updatedAt: 'broken' }), update(100, { lectureDate: '2026-02-30' })]);
  await page.step(0);
  await page.step(1000);
  assert.equal(page.elements.count.textContent, '41');
  assert.equal(page.elements['refresh-status'].dataset.state, 'reconnecting');
  assert.match(page.elements['refresh-text'].textContent, /Last update kept/);
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '42');
  assert.equal(Object.values(page.elements).some(element => element.textContent.includes(privateValue)), false);
  assert.ok(page.calls.slice(1).every(call => call.url.origin + call.url.pathname === LIVE_URL),
    'a remote payload cannot replace the bootstrap relay URL');
  await page.step(1000);
  assert.equal(page.elements.count.textContent, '42');
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '42');
});

test('connection failures back off, retain data and recover to one-second polling', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(41),
    new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), update(42), new Error('offline again')]);
  await page.step(0);
  for (const [before, after] of [[1000, 2000], [2000, 4000], [4000, 8000], [8000, 10000]]) {
    await page.step(before);
    assert.equal(page.delay(), after);
    assert.equal(page.elements.count.textContent, '41');
    assert.equal(page.elements['refresh-status'].dataset.state, 'reconnecting');
  }
  await page.step(10000);
  assert.equal(page.elements.count.textContent, '42');
  assert.equal(page.elements['refresh-status'].dataset.state, 'live');
  assert.equal(page.delay(), 1000);
  await page.step(1000);
  assert.equal(page.delay(), 2000, 'a successful recovery resets the failure backoff');
});

test('unsafe bootstrap endpoints are rejected before any external request', async () => {
  for (const liveEndpoint of ['http://relay.example/api/count', 'https://name:secret@relay.example/api/count', 'https://relay.example/api/count#secret']) {
    const page = await viewer([{ ...unpublished(), liveEndpoint }]);
    assert.equal(page.calls.length, 1);
    assert.equal(page.elements['refresh-status'].dataset.state, 'reconnecting');
    assert.equal(page.delay(), 2000);
  }
});

test('visit statistics start at the first received count, with a thirty-second rate warmup', async () => {
  const page = await viewer([{ ...unpublished(), count: 25, liveEndpoint: LIVE_URL }, update(33), update(33), update(36)]);
  assert.equal(page.elements['observed-change'].textContent, '');
  await page.step(0);
  assert.equal(page.elements['observed-change'].textContent, '0');
  assert.equal(page.elements['observed-rate'].textContent, '—');
  assert.equal(page.elements['observed-duration'].textContent, '00:00');
  assert.equal(page.elements['observed-last-change'].textContent, 'Not yet');
  page.advance(14000);
  await page.step(1000);
  assert.equal(page.elements['observed-rate'].textContent, '—');
  assert.equal(page.elements['observed-duration'].textContent, '00:15');
  page.advance(14000);
  await page.step(1000);
  assert.equal(page.elements['observed-change'].textContent, '+3');
  assert.equal(page.elements['observed-rate'].textContent, '+6.0');
  assert.equal(page.elements['observed-last-change'].textContent, '12:30:30');
  assert.match(page.elements['observation-note'].textContent, /lecture may have started earlier/);
});

test('manual decreases remain signed and chart magnitudes share the same scale', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(100), update(103), update(99), update(80, { lectureDate: '2026-10-23' }), unpublished()]);
  await page.step(0);
  page.advance(29000); await page.step(1000);
  page.advance(29000); await page.step(1000);
  assert.equal(page.elements['observed-change'].textContent, '-1');
  assert.equal(page.elements['observed-rate'].textContent, '-1.0');
  assert.equal(page.elements['activity-bar-8'].attributes.get('height'), '45');
  assert.equal(page.elements['activity-bar-8'].attributes.get('y'), '31');
  assert.equal(page.elements['activity-bar-9'].attributes.get('height'), '60');
  assert.equal(page.elements['activity-bar-9'].attributes.get('y'), '76');
  assert.equal(page.elements['activity-bar-9'].classes.has('negative'), true);
  await page.step(1000);
  assert.equal(page.elements['observed-change'].textContent, '0');
  assert.equal(page.elements['observed-duration'].textContent, '00:00');
  assert.equal(page.elements['observed-last-change'].textContent, 'Not yet');
  await page.step(1000);
  assert.equal(page.elements['observed-change'].textContent, '—');
  assert.equal(page.elements['observed-rate'].textContent, '—');
});

test('failed observations preserve statistics and unobserved minutes are shown as gaps', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(10), update(12), new Error('offline'), update(15)]);
  await page.step(0);
  await page.step(1000);
  assert.equal(page.elements['observed-change'].textContent, '+2');
  await page.step(1000);
  assert.equal(page.elements['observed-duration'].textContent, '00:01');
  assert.equal(page.elements['observed-change'].textContent, '+2');
  page.advance(130000);
  await page.step(2000);
  assert.equal(page.elements['observed-change'].textContent, '+5');
  assert.equal(page.elements['activity-bar-8'].classes.has('unobserved'), true);
  assert.equal(page.elements['activity-bar-9'].classes.has('unobserved'), false);
  assert.match(page.elements['activity-description'].textContent, /Grey periods were not observed/);
});

test('the recent chart expires old changes without losing this visit’s total', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(0), update(1), update(2)]);
  await page.step(0);
  page.advance(59000); await page.step(1000);
  page.advance(599000); await page.step(1000);
  assert.equal(page.elements['observed-change'].textContent, '+2');
  assert.equal(page.elements['observed-duration'].textContent, '11:00');
  assert.match(page.elements['activity-description'].textContent, /oldest first: 0, 0, 0, 0, 0, 0, 0, 0, 0, \+1/);
});

async function filesWithin(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'public assets cannot link outside the public directory');
    if (entry.isDirectory()) files.push(...await filesWithin(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
    else files.push(`${prefix}${entry.name}`);
  }
  return files;
}

test('the Pages artifact contains only the display and explicitly allowed public configuration', async () => {
  assert.deepEqual((await filesWithin(publicRoot)).sort(), ['.nojekyll', 'data/current.json', 'index.html', 'viewer.css', 'viewer.js']);
  const config = JSON.parse(await readFile(new URL('data/current.json', publicRoot), 'utf8'));
  const allowed = new Set(['schemaVersion', 'count', 'lectureDate', 'updatedAt', 'liveEndpoint', 'live']);
  assert.ok(Object.keys(config).every(key => allowed.has(key)), 'public configuration must never contain keys, transcripts or local capture settings');
  assert.equal(config.schemaVersion, 1);
  assert.ok(config.count === null || (Number.isSafeInteger(config.count) && config.count >= 0));
  assert.match(config.lectureDate, /^\d{4}-\d{2}-\d{2}$/);
  if (config.liveEndpoint) {
    const endpoint = new URL(config.liveEndpoint);
    assert.equal(endpoint.protocol, 'https:');
    assert.equal(endpoint.username, '');
    assert.equal(endpoint.password, '');
    assert.equal(endpoint.pathname, '/api/count');
  }
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const css = await readFile(new URL('viewer.css', publicRoot), 'utf8');
  assert.equal(/getUserMedia|MediaRecorder|OPENAI_API_KEY|PUBLISH_TOKEN|api\.openai\.com|wordFrequency/i.test(html + css + viewerSource), false);
  assert.match(html, /src="\.\/viewer\.js(?:\?v=[^"]+)?"/);
  assert.match(html, /href="\.\/viewer\.css(?:\?v=[^"]+)?"/);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(csp);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /form-action 'none'/);
  if (config.liveEndpoint) {
    const connect = csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/)?.[1].trim().split(/\s+/);
    assert.deepEqual(connect, ["'self'", new URL(config.liveEndpoint).origin]);
  }
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /path:\s*public\s*(?:\r?\n|$)/);
});
