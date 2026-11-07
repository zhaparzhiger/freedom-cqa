// AudioWorklet микрофона тренажёра: частота устройства → 16 кГц PCM16 пачками по 100 мс + громкость.
// Отдельный файл, потому что AudioWorklet грузится по адресу (addModule).
class CqaMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sum += s * s;
      this.count++;
    }
    // простое прореживание с линейной интерполяцией: для речи 16 кГц этого достаточно
    while (this.pos < ch.length) {
      const j = Math.floor(this.pos);
      const f = this.pos - j;
      const a = ch[j];
      const b = j + 1 < ch.length ? ch[j + 1] : a;
      const v = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) {
        const rms = Math.sqrt(this.sum / Math.max(1, this.count));
        this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
        this.sum = 0;
        this.count = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("cqa-mic", CqaMic);
