import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from './server.mjs';

async function withServer(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ja-counter-test-'));
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Ja Counter</title>');
  await writeFile(path.join(root, '.env'), 'OPENAI_API_KEY=secret-outside-public');
  const server = createServer({ apiKey: '', publicDir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, server };
}

function upload({ name = 'lecture.webm', text = 'audio-data', language = 'auto' } = {}) {
  const body = new FormData();
  body.append('file', new Blob([text], { type: 'audio/webm' }), name);
  body.append('language', language);
  return body;
}

test('status advertises Whisper and never exposes the configured key', async t => {
  const { url } = await withServer(t, { apiKey: 'sk-secret-server' });
  const response = await fetch(`${url}/api/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: 'whisper-1', hasApiKey: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('transcription rejects missing and malformed keys before sending audio upstream', async t => {
  let calls = 0;
  const { url } = await withServer(t, { fetch: async () => { calls++; } });
  for (const headers of [{}, { Authorization: 'Basic invalid' }, { Authorization: 'Bearer key with spaces' }]) {
    const response = await fetch(`${url}/api/transcribe`, { method: 'POST', headers, body: upload() });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /key/i);
  }
  assert.equal(calls, 0);
});

test('forwards original audio with Whisper timestamps and normalizes the response', async t => {
  const segment = { id: 0, start: 0, end: 2, text: 'That is right, ja.', no_speech_prob: 0.01 };
  let calls = 0;
  const { url } = await withServer(t, {
    apiKey: 'sk-server',
    fetch: async (endpoint, init) => {
      calls++;
      assert.equal(endpoint, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer sk-session');
      assert.ok(init.signal instanceof AbortSignal);
      const form = init.body;
      assert.equal(form.get('model'), 'whisper-1');
      assert.equal(form.get('response_format'), 'verbose_json');
      assert.deepEqual(form.getAll('timestamp_granularities[]'), ['word', 'segment']);
      assert.equal(form.get('temperature'), '0');
      assert.equal(form.get('language'), 'en');
      assert.match(form.get('prompt'), /, ja\./);
      assert.equal(form.get('file').name, 'lecture.webm');
      assert.equal(await form.get('file').text(), 'audio-data');
      return Response.json({ text: 'That is right, ja.', words: [{ word: 'ja.', start: 1.2, end: 1.6 }, { nonsense: true }], segments: [segment], duration: 2, language: 'english', unused: 'omitted' });
    },
  });
  const response = await fetch(`${url}/api/transcribe`, { method: 'POST', headers: { Authorization: 'Bearer sk-session' }, body: upload({ language: 'en' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'That is right, ja.', words: [{ word: 'ja.', start: 1.2, end: 1.6 }], segments: [segment], duration: 2, language: 'english' });
  assert.equal(calls, 1);
});

test('auto language is left for Whisper to detect and server key works', async t => {
  const { url } = await withServer(t, { apiKey: 'sk-server', fetch: async (_endpoint, init) => {
    assert.equal(init.headers.Authorization, 'Bearer sk-server');
    assert.equal(init.body.has('language'), false);
    return Response.json({ text: '', duration: 1 });
  } });
  const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: '', words: [], segments: [], duration: 1, language: null });
});

test('file validation rejects empty, unsupported, oversized, and invalid-language uploads', async t => {
  let calls = 0;
  const { url } = await withServer(t, { apiKey: 'sk-test', audioLimit: 10, fetch: async () => { calls++; } });
  for (const [body, status] of [
    [upload({ text: '' }), 400],
    [upload({ name: 'lecture.txt' }), 400],
    [upload({ text: 'more-than-ten-bytes' }), 413],
    [upload({ language: 'fr' }), 400],
    [new FormData(), 400],
  ]) {
    const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(calls, 0);
});

test('rejects request bodies above the total upload cap', async t => {
  const { url } = await withServer(t, { apiKey: 'sk-test', requestLimit: 20 });
  const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /large/);
});

test('enforces the upload cap for chunked requests without Content-Length', async t => {
  const { url } = await withServer(t, { apiKey: 'sk-test', requestLimit: 20 });
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Transfer-Encoding': 'chunked' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.write('a'.repeat(21));
    request.end();
  });
  assert.equal(response.status, 413);
  assert.match(response.body.error, /large/);
});

test('aborts the upstream transcription when the browser disconnects', async t => {
  let begin;
  let aborted;
  const upstreamStarted = new Promise(resolve => { begin = resolve; });
  const upstreamAborted = new Promise(resolve => { aborted = resolve; });
  const { url } = await withServer(t, { apiKey: 'sk-test', fetch: async (_url, { signal }) => {
    begin();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); }, { once: true }));
  } });
  const controller = new AbortController();
  const pending = fetch(`${url}/api/transcribe`, { method: 'POST', body: upload(), signal: controller.signal }).catch(() => {});
  await upstreamStarted;
  controller.abort();
  let timer;
  await Promise.race([upstreamAborted, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Upstream did not abort')), 1_000); })]).finally(() => clearTimeout(timer));
  await pending;
});

test('maps OpenAI auth, quota, rate limit, invalid audio, and service failures without leaking details or retrying', async t => {
  for (const [status, code, expected, pattern] of [
    [401, 'invalid_api_key', 401, /key/],
    [429, 'insufficient_quota', 429, /quota/],
    [429, 'rate_limit', 429, /rate limiting/],
    [400, 'invalid_audio', 400, /audio/],
    [503, 'unavailable', 502, /unavailable/],
  ]) {
    let calls = 0;
    const { url } = await withServer(t, { apiKey: 'sk-test', fetch: async () => { calls++; return Response.json({ error: { code, message: 'sensitive upstream detail' } }, { status }); } });
    const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
    assert.equal(response.status, expected);
    const result = await response.json();
    assert.match(result.error, pattern);
    assert.doesNotMatch(result.error, /sensitive/);
    assert.equal(calls, 1);
  }
});

test('network errors and invalid successful responses produce readable errors', async t => {
  for (const fetchStub of [async () => { throw new Error('socket secret'); }, async () => new Response('not-json'), async () => Response.json({})]) {
    const { url } = await withServer(t, { apiKey: 'sk-test', fetch: fetchStub });
    const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
    assert.equal(response.status, 502);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('times out upstream requests', async t => {
  const { url } = await withServer(t, { apiKey: 'sk-test', upstreamTimeout: 15, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const response = await fetch(`${url}/api/transcribe`, { method: 'POST', body: upload() });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /longer/);
});

test('blocks remote origins and forged Host headers', async t => {
  const { url } = await withServer(t, { apiKey: 'sk-server' });
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${url}/api/status`, { headers });
    assert.equal(response.status, 403);
  }
  const response = await new Promise((resolve, reject) => {
    http.get(`${url}/api/status`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res); }).on('error', reject);
  });
  assert.equal(response.statusCode, 403);
  assert.equal((await fetch(`${url}/api/status`, { headers: { Origin: url } })).status, 200);
});

test('serves the app and denies traversal to files outside public', async t => {
  const { url } = await withServer(t);
  const index = await fetch(url);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /Ja Counter/);
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  for (const target of ['/%2e%2e%2f.env', '/%2e%2e%5c.env', '/.env', '/server.mjs', '/%00']) {
    const response = await fetch(`${url}${target}`);
    assert.ok([400, 403, 404].includes(response.status), `${target} should be denied`);
    assert.doesNotMatch(await response.text(), /secret-outside-public/);
  }
});
