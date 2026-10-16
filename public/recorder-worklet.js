class LectureCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.position = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.send();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  send() {
    if (!this.position) return;
    const samples = this.buffer.slice(0, this.position);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.position = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.[0]) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.buffer[this.position++] = sample;
      if (this.position === this.buffer.length) this.send();
    }
    return true;
  }
}
registerProcessor('lecture-capture', LectureCapture);
