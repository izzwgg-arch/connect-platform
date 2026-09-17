export function pcmWav(pcm: Float32Array): Uint8Array {
  if (pcm.length < 1600 || pcm.length > 480000) throw new Error("Invalid microphone clip length");
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(pcm[i]) ? pcm[i] : 0));
    view.setInt16(44 + 2 * i, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function wavBase64(pcm: Float32Array): string {
  const bytes = pcmWav(pcm);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192)));
  return btoa(binary);
}

export class LaybelMic {
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private closed = false;
  private activeId: string | null = null;
  private seen = new Set<string>();
  private expected = new Set<string>();
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(private context: AudioContext, private clip: (pcm: Float32Array) => void, private failed: () => void) {}
  async connect(stream: MediaStream) {
    try {
      if (this.context.sampleRate !== 16000) throw new Error("Microphone sample rate unsupported");
      await this.context.audioWorklet.addModule("/laybel-pcm-worklet.js");
      if (this.closed) return;
      this.node = new AudioWorkletNode(this.context, "laybel-pcm", { channelCount: 1, channelCountMode: "explicit" });
      this.node.port.onmessage = ({ data }) => {
        if (this.closed) return;
        if (data.type === "clip" && this.expected.delete(data.id)) this.clip(data.pcm);
        else if (data.type === "too-long") { this.reset(); this.failed(); }
      };
      this.node.onprocessorerror = () => { if (!this.closed) { this.reset(); this.failed(); } };
      this.source = this.context.createMediaStreamSource(stream);
      this.source.connect(this.node); this.node.connect(this.context.destination);
      await this.context.resume();
    } catch (error) { this.close(); throw error; }
  }
  private reset() {
    clearTimeout(this.deadline); this.activeId = null; this.expected.clear();
    this.node?.port.postMessage({ type: "mute", muted: false });
  }
  start(id: string): boolean {
    if (this.closed || !this.node || !id || this.seen.has(id)) return false;
    if (this.activeId) { this.reset(); this.failed(); }
    this.seen.add(id); this.activeId = id;
    this.node.port.postMessage({ type: "start", id });
    // Missing speech-end events must not leave capture/listening stuck forever.
    this.deadline = setTimeout(() => { this.reset(); this.failed(); }, 30_000);
    return true;
  }
  finish(id: string) {
    if (this.closed || this.activeId !== id) return;
    clearTimeout(this.deadline); this.activeId = null; this.expected.add(id);
    this.node?.port.postMessage({ type: "finish" });
  }
  mute(muted: boolean) { clearTimeout(this.deadline); this.activeId = null; this.expected.clear(); this.node?.port.postMessage({ type: "mute", muted }); }
  close() {
    this.closed = true;
    clearTimeout(this.deadline); this.activeId = null; this.expected.clear();
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); }
    this.source?.disconnect();
    void this.context.close().catch(() => {});
  }
}
