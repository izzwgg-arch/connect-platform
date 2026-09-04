import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCallVerdict, selectCallWindow, SILENCE_RMS } from "./callVerdict";

const T0 = Date.parse("2026-09-04T12:00:00.000Z");
const at = (secs: number) => new Date(T0 + secs * 1000);
const row = (secs: number, kind: string, facts: Record<string, unknown> = {}) => ({ createdAt: at(secs), payload: { kind, ...facts } });
const sample = (secs: number, f: Partial<{ rxPkts: number; txPkts: number; lost: number; rxLevel: number; txLevel: number; rttMs: number; jitterMs: number; relay: boolean }>) =>
  row(secs, "media_sample", { rxPkts: 500, txPkts: 500, lost: 0, rxLevel: 0.05, txLevel: 0.04, rttMs: 60, jitterMs: 8, relay: false, ...f });
const end = (secs: number, durationMs: number, extra: Record<string, unknown> = {}) => row(secs, "call_end", { durationMs, ...extra });

const healthy = [
  row(0, "press", { action: "answer" }),
  row(0.5, "mic_opened", { label: "Headset Microphone (Jabra Evolve2)" }),
  row(0.6, "remote_audio_attached", { sinkLabel: "Headset Earphone (Jabra Evolve2)", play: "ok" }),
  sample(10, {}), sample(20, {}), sample(30, {}),
  end(31, 31_000),
];

test("a healthy call is ok, with the evidence lines a person can read", () => {
  const v = computeCallVerdict(healthy);
  assert.equal(v.code, "ok");
  assert.equal(v.facts.samples, 3);
  assert.equal(v.facts.rxPkts, 1500);
  assert.ok(v.evidence.some((l) => l.startsWith("Audio level in")));
  assert.equal(v.facts.micLabel, "Headset Microphone (Jabra Evolve2)");
});

test("⛔ no inbound RTP is the NETWORK, never the headset", () => {
  const v = computeCallVerdict([...healthy.slice(0, 3), sample(10, { rxPkts: 0 }), sample(20, { rxPkts: 0 }), end(21, 21_000)]);
  assert.equal(v.code, "no_inbound_rtp");
  assert.match(v.headline, /Network\/PBX path, not the headset/);
});

test("⛔ packets that arrive carrying silence are the FAR END, not this device", () => {
  const v = computeCallVerdict([...healthy.slice(0, 3), sample(10, { rxLevel: 0.0001 }), sample(20, { rxLevel: 0.002 }), end(21, 21_000)]);
  assert.equal(v.code, "inbound_silent");
  assert.ok(v.facts.rxLevelMax! < SILENCE_RMS);
});

test("a silent microphone for the whole call is mic_silent and names the mic", () => {
  const v = computeCallVerdict([...healthy.slice(0, 3), sample(10, { txLevel: 0 }), sample(20, { txLevel: 0.001 }), end(21, 21_000)]);
  assert.equal(v.code, "mic_silent");
  assert.match(v.headline, /Jabra Evolve2/);
});

test("⛔ the headset-mic-with-default-speaker split is named even when the media looks fine", () => {
  const v = computeCallVerdict([
    row(0, "mic_opened", { label: "Headset Microphone (Jabra Evolve2)" }),
    row(0.6, "remote_audio_attached", { sinkLabel: "Speakers (Realtek(R) Audio)", play: "ok" }),
    sample(10, {}), sample(20, {}),
    end(21, 21_000),
  ]);
  assert.equal(v.code, "split_devices");
  assert.match(v.headline, /Realtek/);
});

test("a failed speaker apply outranks the split and the network", () => {
  const v = computeCallVerdict([
    row(0, "mic_opened", { label: "Headset Microphone (Jabra Evolve2)" }),
    row(0.2, "speaker_select_failed", { label: "Headset Earphone (Jabra Evolve2)", error: "NotFoundError", why: "setting" }),
    row(0.6, "remote_audio_attached", { sinkLabel: "System default", play: "ok" }),
    sample(10, { lost: 100 }),
    end(11, 11_000),
  ]);
  assert.equal(v.code, "speaker_apply_failed");
  assert.match(v.headline, /Windows default output/);
});

test("a mount-time no_audio_element speaker failure is NOT a call failure", () => {
  const v = computeCallVerdict([
    row(-30, "speaker_select_failed", { label: "Headset", error: "no_audio_element", why: "setting" }),
    ...healthy,
  ]);
  assert.equal(v.code, "ok");
});

test("playback blocked and mic-open failures are the top of the ladder", () => {
  assert.equal(computeCallVerdict([...healthy.slice(0, 2), row(0.6, "remote_audio_play_blocked", { sinkLabel: "x", error: "NotAllowedError" }), sample(10, {}), end(11, 11_000)]).code, "playback_blocked");
  assert.equal(computeCallVerdict([row(0, "mic_open_failed", { label: "USB Mic", error: "NotReadableError" }), sample(10, {}), end(11, 11_000)]).code, "mic_open_failed");
});

test("poor network is reported only when audio flowed both ways", () => {
  const v = computeCallVerdict([...healthy.slice(0, 3), sample(10, { lost: 60, rttMs: 480, jitterMs: 90 }), sample(20, { lost: 60, rttMs: 500 }), end(21, 21_000)]);
  assert.equal(v.code, "poor_network");
  assert.equal(v.facts.rttMedianMs, 490);
});

test("short calls and sample-less calls are judged as such, never as failures", () => {
  assert.equal(computeCallVerdict([row(0, "mic_opened", { label: "x" }), end(2, 1_500)]).code, "short_call");
  assert.equal(computeCallVerdict([row(0, "mic_opened", { label: "x" }), end(20, 20_000)]).code, "no_data");
});

test("⛔ the window starts at THIS call's mic_opened — a previous call's failure never leaks in", () => {
  const rows = [
    row(-200, "mic_opened", { label: "old" }),
    row(-199, "remote_audio_play_blocked", { sinkLabel: "old", error: "NotAllowedError" }),
    end(-190, 10_000),
    ...healthy,
  ];
  const win = selectCallWindow(rows);
  // The window opens at the LAST start marker (mic_opened follows the answer press).
  assert.equal(win[0]!.payload!.kind, "mic_opened");
  assert.ok(!win.some((r) => r.payload!.kind === "remote_audio_play_blocked"), "the old call's failure is outside the window");
  assert.equal(computeCallVerdict(rows).code, "ok");
});
