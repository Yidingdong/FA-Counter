import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleMono, encodeWav, fileChunk, isSilent, CHUNK_SECONDS, OVERLAP_SECONDS } from '../public/audio.mjs';

const readText = (view, start, length) => String.fromCharCode(...new Uint8Array(view.buffer, start, length));
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `expected ${actual} to be within ${tolerance} of ${expected}`);

function audioBuffer(duration, rate = 16000, amplitudes = [0.5]) {
  const channels = amplitudes.map(amplitude => new Float32Array(Math.round(duration * rate)).fill(amplitude));
  return { duration: channels[0].length / rate, sampleRate: rate, numberOfChannels: channels.length,
    getChannelData: index => channels[index] };
}

test('resampling common source rates preserves duration and mono amplitude', () => {
  for (const rate of [8000, 16000, 44100, 48000]) {
    const result = resampleMono([new Float32Array(rate).fill(0.25)], rate);
    assert.equal(result.length, 16000, `one second at ${rate} Hz`);
    near(result[0], 0.25); near(result.at(-1), 0.25);
  }
});

test('resampling downmixes every channel and honors selected source bounds', () => {
  const left = new Float32Array(48000).fill(0.8, 12000, 36000);
  const right = new Float32Array(48000).fill(-0.4, 12000, 36000);
  const result = resampleMono([left, right], 48000, 12000, 36000);
  assert.equal(result.length, 8000);
  for (const sample of result) near(sample, 0.2);
  assert.equal(resampleMono([left, right], 48000, 100, 100).length, 0);
  const averaged = resampleMono([Float32Array.from([0, 0.3, 0.6, 0.3, 0.6, 0.9])], 48000);
  near(averaged[0], 0.3); near(averaged[1], 0.6);
});

test('WAV encoding writes a mono RIFF PCM16 header and correctly clips signed samples', async () => {
  const blob = encodeWav(Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2]));
  assert.equal(blob.type, 'audio/wav');
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.byteLength, 58);
  assert.equal(readText(view, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), view.byteLength - 8);
  assert.equal(readText(view, 8, 4), 'WAVE');
  assert.equal(readText(view, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(readText(view, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), 14);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true)),
    [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  const empty = new DataView(await encodeWav(new Float32Array(), 8000).arrayBuffer());
  assert.equal(empty.byteLength, 44);
  assert.equal(empty.getUint32(24, true), 8000);
  assert.equal(empty.getUint32(40, true), 0);
});

test('file chunks cover the full recording with touching ownership intervals, including final overlap', async () => {
  const step = CHUNK_SECONDS - OVERLAP_SECONDS;
  for (const duration of [0.25, 11.9, 12, 12.05, 22, 23, 24.1]) {
    const buffer = audioBuffer(duration);
    const chunks = [];
    for (let offset = 0; offset < buffer.duration; offset += step) {
      const chunk = fileChunk(buffer, offset);
      chunks.push(chunk);
      assert.ok(chunk.to > chunk.from, `nonempty ownership for ${duration}s at ${offset}s`);
      assert.equal(chunk.silent, false);
      const wav = new DataView(await chunk.blob.arrayBuffer());
      const wavDuration = wav.getUint32(40, true) / 2 / 16000;
      near(wavDuration, chunk.end - chunk.offset, 1 / 16000);
      if (chunk.final) break;
    }
    assert.equal(chunks[0].from, 0);
    assert.equal(chunks.at(-1).final, true);
    near(chunks.at(-1).end, buffer.duration);
    assert.ok(chunks.at(-1).to > buffer.duration);
    for (let i = 1; i < chunks.length; i++) {
      near(chunks[i - 1].to, chunks[i].from);
      near(chunks[i - 1].end - chunks[i].offset, OVERLAP_SECONDS);
    }
    // The last half-second of each window must have one owner, even at a final short window.
    for (let time = 0; time < duration; time += 0.137) {
      assert.equal(chunks.filter(chunk => time >= chunk.from && time < chunk.to).length, 1,
        `${time}s of ${duration}s must have exactly one owner`);
    }
  }
});

test('file chunks apply a session base to ownership and all reported timestamps', () => {
  const buffer = audioBuffer(14, 48000, [0.75, -0.25]);
  const first = fileChunk(buffer, 0, 60);
  const final = fileChunk(buffer, 11, 60);
  assert.equal(first.offset, 60);
  assert.equal(first.from, 60);
  assert.equal(first.to, 71.5);
  assert.equal(first.end, 72);
  assert.equal(final.offset, 71);
  assert.equal(final.from, 71.5);
  assert.equal(final.end, 74);
  near(final.to, 74.001);
  assert.equal(final.final, true);
});

test('silence is detected from RMS across the whole chunk', () => {
  assert.equal(isSilent(new Float32Array()), true);
  assert.equal(isSilent(new Float32Array(16000)), true);
  assert.equal(isSilent(new Float32Array(16000).fill(0.0005)), true);
  assert.equal(isSilent(new Float32Array(16000).fill(0.01)), false);
  assert.equal(fileChunk(audioBuffer(1, 16000, [0]), 0).silent, true);
  assert.equal(fileChunk(audioBuffer(1, 16000, [0.5, -0.5]), 0).silent, true);
});
