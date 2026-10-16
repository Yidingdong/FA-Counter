# ja. — Live lecture word counter

A GitHub Pages app for the professor who finishes every explanation with “ja”.

**Website:** https://www.itsyid.com/FA-Counter/ (GitHub Pages, using the account's existing custom domain).

## Use it

1. Open the site in a current Chrome, Edge, Firefox, or Safari browser.
2. Open **Settings**, enter your own OpenAI API key, and save. Keep the default auto language hint initially.
3. Select your microphone and press **Start listening**. Allow microphone access.
4. Counts and the transcript update after each roughly 12-second audio window plus API processing time. **Finish session** flushes the last window.
5. Review matches, search the vocabulary, and **Export** a CSV before closing the tab.

The page shows the total number of transcribed words, a frequency table for **every word** (including “the”, “and”, and other common words), the “ja” total, timestamps, and a frequency chart. Words are case-insensitive, punctuation is removed, and contractions such as “don't” stay together. The “ja” counter uses whole-word boundaries, so “Java” never counts. “Yeah”/“ya” and sentence-ending-only counting are optional. Sentence endings use punctuation or a pause heuristic.

You can upload browser-decodable audio or video audio up to 200 MB instead. Recordings are decoded in browser memory and split into small WAV windows automatically; long files can need substantial memory. MP3/WAV are reliable choices when another container cannot be decoded. Cancel keeps completed results. Failed windows remain in memory for an explicit retry or reset; the app does not retry billed requests automatically.

**Try a sample** uses clearly labeled sample text, without using the microphone or API.

## How live counting works

The microphone runs through an AudioWorklet, mixes to mono, and sends 16 kHz PCM WAV windows to OpenAI's **`whisper-1` transcription endpoint**. Each window is 12 seconds, with 1 second of shared context. Word timestamps assign each overlap to only one window, preventing duplicate counts while keeping rapid repeated words. Quiet windows are skipped. This is near-live chunked transcription, with about 12 seconds of capture delay plus network/model latency, rather than token streaming.

Whisper is guided with a short example of English speech containing German “ja” interjections, and translation is never requested. Recognition is still an estimate: very short interjections, noise, overlapping speakers, and English/German code switching can produce missed or incorrect words. The microphone captures everyone it hears; it does not identify the professor. Review the transcript and use the match exclusion or manual “ja” correction controls when necessary. If needed, compare auto, English, and German hints on a short recording.

## Keys and data

GitHub Pages has no backend. On the hosted site, audio is sent **directly from your browser to `https://api.openai.com/v1/audio/transcriptions`**, using your key. API usage is billed to that key's account. The key is held in this tab's JavaScript memory and is never written to localStorage, sessionStorage, cookies, the repository, or GitHub Actions. Audio, results, and pending requests are also held only in tab memory. Refreshing/closing the tab clears the session, so export first. No analytics or third-party scripts are included.

Use your own key on your own device. This browser-only design intentionally does not ship a shared API key or accept a key through URL parameters. A server-side key can be used with the optional localhost server below.

## Local development

Requires Node.js 22 or later. There are **no npm dependencies** and no build step.

```sh
npm start
```

Open http://127.0.0.1:3000. Enter a key in Settings, or copy `.env.example` to `.env` and set `OPENAI_API_KEY` on your computer. The optional localhost server proxies transcription requests; `.env` is ignored by Git. It binds to loopback only, validates Host/Origin, limits uploads, and does not retain audio or keys in logs.

```sh
npm test
```

Tests cover word boundaries and frequencies, overlapping-window ownership, WAV encoding, resampling, CSV export, and server behavior using a mocked upstream. Real speech accuracy and billing require a user-supplied key and a representative lecture recording.

## GitHub Pages deployment

The `.github/workflows/pages.yml` workflow tests and publishes **only `public/`** on each push to `main`. In the repository's **Settings → Pages**, the source is **GitHub Actions**. No API key or repository secret is required for deployment. The optional local server and `.env` files are not part of the published artifact.

API references: [OpenAI transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) and [transcription endpoint](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
