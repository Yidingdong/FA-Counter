import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_LIMIT = 24_000_000;
const REQUEST_LIMIT = 25_000_000;
const EXTENSIONS = new Set(['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Small .env reader: never evaluates shell expressions or overwrites environment variables. */
export async function loadEnv(filename = path.join(ROOT, '.env')) {
  let contents;
  try { contents = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    process.env[match[1]] = value;
  }
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function isLocalRequest(req) {
  const port = req.socket.localPort;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (port === 80) { hosts.add('localhost'); hosts.add('127.0.0.1'); }
  if (!hosts.has(req.headers.host?.toLowerCase())) return false;
  if (req.headers.origin && !new Set([...hosts].map(host => `http://${host}`)).has(req.headers.origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new HttpError(413, 'This request is too large. Use an audio file smaller than 24 MB.');
  }
  return new Promise((resolve, reject) => {
    const parts = [];
    let length = 0;
    function cleanup() { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); }
    function onError(error) { cleanup(); reject(error); }
    function onAborted() { onError(new HttpError(400, 'The audio upload was interrupted.')); }
    function onEnd() { cleanup(); resolve(Buffer.concat(parts, length)); }
    function onData(chunk) {
      length += chunk.length;
      if (length > limit) {
        cleanup();
        req.resume();
        reject(new HttpError(413, 'This request is too large. Use an audio file smaller than 24 MB.'));
      } else parts.push(chunk);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function selectKey(req, envKey) {
  const header = req.headers.authorization;
  if (header === undefined) return envKey?.trim() || '';
  const match = header.match(/^Bearer ([^\s\x00-\x1f\x7f]{1,1024})$/i);
  if (!match) throw new HttpError(401, 'Enter a valid OpenAI API key, or remove the session key to use the server key.');
  return match[1];
}

function upstreamError(status, payload) {
  const code = payload?.error?.code;
  if (status === 401 || status === 403) return new HttpError(401, 'OpenAI rejected the API key. Check the key and its project permissions.');
  if (status === 429 && (code === 'insufficient_quota' || code === 'billing_hard_limit_reached')) return new HttpError(429, 'Your OpenAI API account has no available quota. Check API billing and project limits.');
  if (status === 429) return new HttpError(429, 'OpenAI is rate limiting requests. Wait a moment, then try again.');
  if (status === 413) return new HttpError(413, 'OpenAI rejected the audio size. Use a shorter recording or a smaller file.');
  if (status === 400 || status === 422) return new HttpError(400, 'OpenAI could not read this audio. Try a valid MP3, M4A, WAV, or WebM file.');
  return new HttpError(502, 'OpenAI transcription is temporarily unavailable. Please try again later.');
}

async function transcribe(req, res, options) {
  const apiKey = selectKey(req, options.apiKey);
  if (!apiKey) throw new HttpError(401, 'Add your OpenAI API key in Settings, or set OPENAI_API_KEY in the server .env file.');
  const contentType = req.headers['content-type'] || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new HttpError(415, 'Upload audio as multipart/form-data with a file field.');
  const body = await readBody(req, options.requestLimit);
  let fields;
  try {
    fields = await new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': contentType }, body }).formData();
  } catch { throw new HttpError(400, 'The audio upload could not be read. Please select the file again.'); }
  const file = fields.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'Choose an audio file first.');
  if (file.size === 0) throw new HttpError(400, 'The audio file is empty.');
  if (file.size > options.audioLimit) throw new HttpError(413, 'The audio file is too large. Use a file smaller than 24 MB.');
  if (!EXTENSIONS.has(path.extname(file.name).toLowerCase())) throw new HttpError(400, 'Unsupported file type. Use MP3, MP4, MPEG, MPGA, M4A, WAV, WebM, OGG, or FLAC.');
  const language = fields.get('language') || 'auto';
  if (!['auto', 'en', 'de'].includes(language)) throw new HttpError(400, 'Language must be auto, en, or de.');
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  form.append('prompt', "Today we are discussing the next step, ja. This works in the same way, ja. Okay, let's continue.");
  if (language !== 'auto') form.append('language', language);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.upstreamTimeout);
  timer.unref?.();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try {
    if (res.destroyed) return;
    const response = await options.fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal,
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new HttpError(502, 'OpenAI returned an unreadable transcription response. Please try again.'); }
    if (!response.ok) throw upstreamError(response.status, payload);
    if (typeof payload?.text !== 'string') throw new HttpError(502, 'OpenAI returned an incomplete transcription response. Please try again.');
    json(res, 200, {
      text: payload.text,
      words: Array.isArray(payload.words) ? payload.words.filter(item => typeof item?.word === 'string' && Number.isFinite(item.start) && Number.isFinite(item.end)).map(({ word, start, end }) => ({ word, start, end })) : [],
      segments: Array.isArray(payload.segments) ? payload.segments : [],
      duration: Number.isFinite(payload.duration) ? payload.duration : null,
      language: typeof payload.language === 'string' ? payload.language : null,
    });
  } catch (error) {
    if (timedOut) throw new HttpError(504, 'Transcription took longer than two minutes. Try a shorter recording.');
    if (controller.signal.aborted) return;
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Could not connect to OpenAI. Check your internet connection and try again.');
  } finally { clearTimeout(timer); res.off('close', onClose); }
}

async function serveStatic(req, res, publicDir) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { throw new HttpError(400, 'Invalid URL.'); }
  if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(403, 'File access denied.');
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filename = path.resolve(publicDir, `.${requested}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) throw new HttpError(403, 'File access denied.');
  let contents;
  try {
    const [realFile, realPublic] = await Promise.all([realpath(filename), realpath(publicDir)]);
    if (!realFile.startsWith(`${realPublic}${path.sep}`)) throw new HttpError(403, 'File access denied.');
    if (!(await stat(filename)).isFile()) throw new HttpError(404, 'File not found.');
    contents = await readFile(filename);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, 'File not found.');
    throw error;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : contents);
}

export function createServer(options = {}) {
  const config = {
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? '',
    fetch: options.fetch ?? globalThis.fetch,
    publicDir: path.resolve(options.publicDir ?? path.join(ROOT, 'public')),
    audioLimit: options.audioLimit ?? AUDIO_LIMIT,
    requestLimit: options.requestLimit ?? REQUEST_LIMIT,
    upstreamTimeout: options.upstreamTimeout ?? 120_000,
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.openai.com; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!isLocalRequest(req)) throw new HttpError(403, 'Only requests from this localhost app are allowed.');
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/status' && req.method === 'GET') return json(res, 200, { model: 'whisper-1', hasApiKey: Boolean(config.apiKey.trim()) });
      if (pathname === '/api/transcribe' && req.method === 'POST') return await transcribe(req, res, config);
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'API route not found.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      await serveStatic(req, res, config.publicDir);
    } catch (error) {
      json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'An unexpected server error occurred. Please try again.' });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await loadEnv();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createServer();
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Close the other app or choose another PORT in .env.` : 'The local server could not start.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Ja Counter is ready at http://localhost:${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  }
}
