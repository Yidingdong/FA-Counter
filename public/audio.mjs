const RATE = 16000;
export const CHUNK_SECONDS = 12;
export const OVERLAP_SECONDS = 1;

export function resampleMono(channels, sourceRate, start = 0, end = channels[0].length) {
  const step = sourceRate / RATE;
  const output = new Float32Array(Math.max(0, Math.floor((end - start) / step)));
  for (let i = 0; i < output.length; i++) {
    const left = Math.floor(start + i * step);
    const right = Math.min(end, Math.floor(start + (i + 1) * step));
    let sum = 0;
    let count = 0;
    for (let j = left; j < Math.max(left + 1, right); j++) {
      for (const channel of channels) { sum += channel[Math.min(j, channel.length - 1)] || 0; count++; }
    }
    output[i] = sum / count;
  }
  return output;
}

export function encodeWav(samples, rate = RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
  return new Blob([buffer], { type: 'audio/wav' });
}

export function isSilent(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return !samples.length || Math.sqrt(sum / samples.length) < 0.001;
}

export class MicrophoneCapture {
  constructor({ onChunk, onLevel }) {
    this.onChunk = onChunk; this.onLevel = onLevel; this.pending = new Float32Array(0); this.offset = 0;
  }
  async start(deviceId) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false });
      this.context = new AudioContext({ sampleRate: RATE });
      await this.context.resume();
      await this.context.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'lecture-capture');
      this.mute = this.context.createGain(); this.mute.gain.value = 0;
      this.worklet.port.onmessage = ({ data }) => {
        if (data.flushed) { this.flushResolve?.(); return; }
        if (data.samples) this.accept(data.samples);
      };
      this.source.connect(this.worklet); this.worklet.connect(this.mute); this.mute.connect(this.context.destination);
    } catch (error) { await this.dispose(); throw error; }
  }
  accept(samples) {
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    this.onLevel?.(Math.min(1, Math.sqrt(energy / samples.length) * 7));
    const joined = new Float32Array(this.pending.length + samples.length); joined.set(this.pending); joined.set(samples, this.pending.length);
    this.pending = joined;
    const size = Math.round(this.context.sampleRate * CHUNK_SECONDS);
    const step = Math.round(this.context.sampleRate * (CHUNK_SECONDS - OVERLAP_SECONDS));
    while (this.pending.length >= size) {
      this.emit(this.pending.slice(0, size), false);
      this.pending = this.pending.slice(step); this.offset += step / this.context.sampleRate;
    }
  }
  emit(samples, final) {
    const duration = samples.length / this.context.sampleRate;
    const end = this.offset + duration;
    const mono = resampleMono([samples], this.context.sampleRate);
    this.onChunk({ blob: encodeWav(mono), offset: this.offset, from: this.offset ? this.offset + OVERLAP_SECONDS / 2 : 0,
      to: final ? end + 0.001 : end - OVERLAP_SECONDS / 2, end, silent: isSilent(mono) });
  }
  async stop() {
    if (!this.worklet) return;
    this.source.disconnect();
    await new Promise(resolve => {
      this.flushResolve = resolve; this.worklet.port.postMessage('flush'); setTimeout(resolve, 1000);
    });
    if (this.pending.length) this.emit(this.pending, true);
    await this.dispose();
  }
  async dispose() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.source?.disconnect(); this.worklet?.disconnect(); this.mute?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}

/** Decode once, then encode bounded WAV windows. Nothing is stored on the server. */
export async function decodeFile(file) {
  if (file.size > 200 * 1024 * 1024) throw new Error('This recording is over 200 MB. Please split or compress it first.');
  const context = new AudioContext();
  try { return await context.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('Your browser could not decode this recording. Try an MP3, WAV, M4A, or WebM audio file.'); }
  finally { await context.close(); }
}

export function fileChunk(buffer, offset, base = 0) {
  const duration = Math.min(CHUNK_SECONDS, buffer.duration - offset);
  const end = offset + duration;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const samples = resampleMono(channels, buffer.sampleRate, Math.floor(offset * buffer.sampleRate), Math.floor(end * buffer.sampleRate));
  const final = end >= buffer.duration - 0.001;
  return { blob: encodeWav(samples), offset: base + offset, from: base + (offset ? offset + OVERLAP_SECONDS / 2 : 0),
    to: base + (final ? end + 0.001 : end - OVERLAP_SECONDS / 2), end: base + end, silent: isSilent(samples), final };
}
