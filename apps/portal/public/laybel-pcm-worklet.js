/* Bounded in-memory mic capture. Anam VAD marks turns; its transcript is unused.
 * Half-second pre-roll preserves syllables spoken before the VAD event arrives. */
class LaybelPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(8000);
    this.cursor = 0; this.count = 0; this.active = null; this.used = 0;
    this.enabled = true; this.overflow = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'mute') {
        this.enabled = !data.muted; this.active = null; this.used = 0;
        this.count = 0; this.cursor = 0; this.overflow = false; this.ring.fill(0);
      } else if (data.type === 'start' && this.enabled && !this.active && !this.overflow) {
        this.id = data.id;
        this.active = new Float32Array(480000); this.used = 0;
        for (let i = 0; i < this.count; i++) {
          this.active[this.used++] = this.ring[(this.cursor - this.count + i + this.ring.length) % this.ring.length];
        }
        this.count = 0;
      } else if (data.type === 'finish') {
        if (this.active && this.used >= 1600) {
          const pcm = this.active.slice(0, this.used);
          this.port.postMessage({ type: 'clip', pcm, id: this.id }, [pcm.buffer]);
        }
        this.active = null; this.used = 0; this.count = 0; this.overflow = false;
      }
    };
  }
  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      if (this.active) {
        if (this.used >= this.active.length) {
          this.active = null; this.used = 0; this.overflow = true;
          this.port.postMessage({ type: 'too-long' });
        } else this.active[this.used++] = sample;
      } else if (!this.overflow) {
        this.ring[this.cursor] = sample;
        this.cursor = (this.cursor + 1) % this.ring.length;
        this.count = Math.min(this.count + 1, this.ring.length);
      }
    }
    return true; // Outputs remain zero: never play microphone audio locally.
  }
}
registerProcessor('laybel-pcm', LaybelPcm);
