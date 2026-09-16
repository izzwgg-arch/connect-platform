import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { LaybelMic, pcmWav, wavBase64 } from "./laybelMic";
import { LaybelTurns } from "./laybelTurns";

function processor() {
  let Constructor: any;
  const events: any[] = [];
  const context = vm.createContext({ Float32Array, AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (data: any) => events.push(data) }; }, registerProcessor: (_name: string, value: any) => { Constructor = value; } });
  vm.runInContext(readFileSync(new URL("../public/laybel-pcm-worklet.js", import.meta.url), "utf8"), context);
  const worker = new Constructor();
  return { worker, events, command: (type: string, values = {}) => worker.port.onmessage({ data: { type, ...values } }), samples: (count: number, value: number) => worker.process([[new Float32Array(count).fill(value)]]) };
}

test("worklet includes bounded pre-roll, records one clip, never emits idle audio", () => {
  const p = processor();
  p.samples(9000, .2); assert.equal(p.events.length, 0);
  p.command("start"); p.command("start"); p.samples(2000, .4); p.command("finish"); p.command("finish");
  assert.equal(p.events.length, 1); const pcm = p.events[0].pcm;
  assert.equal(pcm.length, 10000); assert.ok(Math.abs(pcm[0] - .2) < .001); assert.ok(Math.abs(pcm[9999] - .4) < .001);
});

test("mute discards pending audio and pre-roll; overflow discards the whole turn", () => {
  const p = processor(); p.samples(8000, .2); p.command("start"); p.samples(2000, .4);
  p.command("mute", { muted: true }); p.samples(8000, .8); p.command("finish"); assert.equal(p.events.length, 0);
  p.command("mute", { muted: false }); p.command("start"); p.samples(480001, .3); p.command("finish");
  assert.equal(p.events.length, 1); assert.equal(p.events[0].type, "too-long");
  p.command("start"); p.samples(2000, .5); p.command("finish"); assert.equal(p.events[1].pcm.length, 2000);
});

test("WAV has canonical 16kHz mono PCM header and clamped samples", () => {
  const pcm = new Float32Array(2000); pcm.set([-2, 2, 0, NaN]);
  const bytes = pcmWav(pcm); const b = Buffer.from(bytes);
  assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt32LE(40), 4000);
  assert.deepEqual([44, 46, 48, 50].map(offset => b.readInt16LE(offset)), [-32768, 32767, 0, 0]);
  assert.deepEqual(Buffer.from(wavBase64(pcm), "base64"), b);
  assert.throws(() => pcmWav(new Float32Array(480001)));
});

test("ending capture during worklet load closes context and never connects mic", async () => {
  let release!: () => void; let closed = 0;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  const context = { sampleRate: 16000, audioWorklet: { addModule: () => loaded }, close: async () => { closed++; }, createMediaStreamSource: () => assert.fail("late mic connection") };
  const capture = new LaybelMic(context as any, () => assert.fail(), () => assert.fail());
  const pending = capture.connect({} as any); capture.close(); release(); await pending; assert.equal(closed, 1);
});

test("YL transcript and detected Yiddish drive one assistant turn, English speaks and Yiddish stays in chat", async () => {
  const spoken: string[] = []; let asks = 0;
  const turns = new LaybelTurns(async (text, _speech, language) => {
    asks++; assert.equal(text, "שלום"); assert.equal(language, "yi");
    return { reply: "פיר", spokenReply: "Four." };
  }, async text => { spoken.push(text); }, () => assert.fail(), () => assert.fail());
  const prepare = async () => ({ text: "שלום", language: "yi" as const });
  await turns.submit("clip", prepare); await turns.submit("clip", prepare);
  assert.equal(asks, 1); assert.deepEqual(spoken, ["Four."]);
});

test("capture pairs VAD correlation IDs, ignores duplicate events and discards late muted clips", async t => {
  const original = (globalThis as any).AudioWorkletNode;
  const commands: any[] = []; const clips: Float32Array[] = []; let node: any;
  (globalThis as any).AudioWorkletNode = class {
    port = { postMessage: (v: any) => commands.push(v), close() {}, onmessage: null as any };
    constructor() { node = this; }
    connect() {} disconnect() {}
  };
  t.after(() => { if (original === undefined) delete (globalThis as any).AudioWorkletNode; else (globalThis as any).AudioWorkletNode = original; });
  const capture = new LaybelMic({ sampleRate: 16000, audioWorklet: { addModule: async () => {} }, close: async () => {}, resume: async () => {}, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }) } as any, pcm => clips.push(pcm), () => assert.fail());
  t.after(() => capture.close()); await capture.connect({} as any);
  assert.equal(capture.start("one"), true); assert.equal(capture.start("one"), false);
  capture.finish("wrong"); assert.equal(commands.filter(v => v.type === "finish").length, 0);
  capture.finish("one"); capture.finish("one");
  assert.equal(commands.filter(v => v.type === "finish").length, 1);
  node.port.onmessage({ data: { type: "clip", id: "one", pcm: new Float32Array(2000) } }); assert.equal(clips.length, 1);
  capture.start("two"); capture.finish("two"); capture.mute(true);
  node.port.onmessage({ data: { type: "clip", id: "two", pcm: new Float32Array(2000) } }); assert.equal(clips.length, 1);
  assert.equal(capture.start("one"), false);
});

test("failed transcription calls no AI; closing pending STT aborts and ignores its late response", async () => {
  let failed = 0; let signal!: AbortSignal; let release!: (v: { text: string }) => void;
  const turns = new LaybelTurns(async () => assert.fail("AI must not run"), async () => assert.fail(), () => { failed++; }, () => assert.fail());
  await turns.submit("failure", async () => { throw new Error("YL unavailable"); }); assert.equal(failed, 1);
  const pending = turns.submit("late", value => { signal = value; return new Promise(resolve => { release = resolve; }); });
  await Promise.resolve(); turns.close(); assert.equal(signal.aborted, true); release({ text: "late" }); await pending;
  assert.equal(failed, 1);
});
