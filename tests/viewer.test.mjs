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
  const ids = ['count', 'count-caption', 'lecture-date', 'updated-at', 'refresh-status', 'refresh-text'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const timers = new Map(), calls = [], listeners = new Map();
  let nextTimer = 0;
  const document = { hidden: false, getElementById: id => elements[id],
    addEventListener: (name, callback) => listeners.set(name, callback) };
  const context = vm.createContext({ document, URL, Intl, Date, AbortController,
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
    delay() {
      assert.equal(timers.size, 1, 'only the next refresh timer should remain after a completed request');
      return [...timers.values()][0].delay;
    },
    async step(expectedDelay) {
      assert.equal(timers.size, 1);
      const [id, task] = [...timers][0];
      if (expectedDelay !== undefined) assert.equal(task.delay, expectedDelay);
      timers.delete(id);
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

test('bootstrap selects the relay then polls at two seconds and displays live updates', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(41), update(42)]);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url.pathname, '/ja-counter/data/current.json');
  assert.equal(page.delay(), 0);
  await page.step(0);
  assert.equal(page.calls[1].url.origin + page.calls[1].url.pathname, LIVE_URL);
  assert.ok(page.calls[1].url.searchParams.has('t'));
  assert.equal(page.elements.count.textContent, '41');
  assert.equal(page.elements['refresh-status'].dataset.state, 'live');
  assert.equal(page.delay(), 2000);
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '42');
  assert.equal(page.delay(), 2000);
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
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '41');
  assert.equal(page.elements['refresh-status'].dataset.state, 'reconnecting');
  assert.match(page.elements['refresh-text'].textContent, /Last update kept/);
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '42');
  assert.equal(Object.values(page.elements).some(element => element.textContent.includes(privateValue)), false);
  assert.ok(page.calls.slice(1).every(call => call.url.origin + call.url.pathname === LIVE_URL),
    'a remote payload cannot replace the bootstrap relay URL');
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '42');
  await page.step(2000);
  assert.equal(page.elements.count.textContent, '42');
});

test('connection failures back off, retain data and recover to two-second polling', async () => {
  const page = await viewer([{ ...unpublished(), liveEndpoint: LIVE_URL }, update(41),
    new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), update(42), new Error('offline again')]);
  await page.step(0);
  for (const [before, after] of [[2000, 2000], [2000, 4000], [4000, 8000], [8000, 10000]]) {
    await page.step(before);
    assert.equal(page.delay(), after);
    assert.equal(page.elements.count.textContent, '41');
    assert.equal(page.elements['refresh-status'].dataset.state, 'reconnecting');
  }
  await page.step(10000);
  assert.equal(page.elements.count.textContent, '42');
  assert.equal(page.elements['refresh-status'].dataset.state, 'live');
  assert.equal(page.delay(), 2000);
  await page.step(2000);
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
  assert.match(html, /src="\.\/viewer\.js"/);
  assert.match(html, /href="\.\/viewer\.css"/);
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
