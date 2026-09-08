import "./requeueTestEnv";
import test from "node:test";
import assert from "node:assert/strict";
import { TelephonyService } from "./TelephonyService";
import { CallStateStore } from "../state/CallStateStore";
import { isHelperChannel, isPseudoChannel } from "../normalizers/normalizeCallEvent";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import type { NormalizedCall } from "../types";

/**
 * Regression guard for the "<unknown> → h" ghost on Active Calls (2026-09-08).
 *
 * Asterisk keeps ONE permanent pseudo-channel, `Message/ast_msg_queue`, for the
 * life of the process. `core show channels` lists it as Up / context `messages`
 * / exten `h` with no caller ID and a days-long duration, and it never emits a
 * Hangup. Every AMI bootstrap (`CoreShowChannels` after connect/reconnect)
 * replayed it as a CoreShowChannel frame; the helper-channel guard only skipped
 * helpers WITHOUT a linkedid, and this one carries its own, so the store created
 * a helper-only call and the broadcaster pushed `call.upsert` (state up, from
 * "<unknown>", to "h", tenant null → admin sockets). It is excluded from every
 * snapshot and every sweep, and its Hangup never comes, so no `call.remove` ever
 * followed: a super-admin tab open across a reboot showed the row until refresh.
 *
 * Run:
 *   pnpm --filter @connect/telephony exec tsx --test src/telephony/services/pseudoChannelBootstrap.test.ts
 */

function makeService(): { svc: TelephonyService; calls: CallStateStore; upserts: NormalizedCall[] } {
  const ami = {
    on: () => undefined,
    sendAction: () => "actionId-1",
  } as unknown as AmiClient;
  const ari = { on: () => undefined } as unknown as AriClient;
  const calls = new CallStateStore();
  const upserts: NormalizedCall[] = [];
  calls.on("callUpsert", (call: NormalizedCall) => upserts.push(call));
  const extensions = {} as unknown as ExtensionStateStore;
  const queues = {} as unknown as QueueStateStore;
  const svc = new TelephonyService(ami, ari, calls, extensions, queues);
  return { svc, calls, upserts };
}

function dispatch(svc: TelephonyService, frame: Record<string, string>): void {
  // handleAmiFrame is the single entry point for every AMI event; it is
  // private, so reach it the way the AMI "event" binding does.
  (svc as unknown as { handleAmiFrame: (f: Record<string, string>) => void }).handleAmiFrame(frame);
}

// Verbatim shape of the production frame (uniqueid 1788305013.58084 was the
// channel that ghosted on 2026-09-08; it had been up for 163 hours).
const MESSAGE_QUEUE_FRAME = {
  Event: "CoreShowChannel",
  Channel: "Message/ast_msg_queue",
  ChannelState: "6",
  ChannelStateDesc: "Up",
  CallerIDNum: "<unknown>",
  CallerIDName: "<unknown>",
  ConnectedLineNum: "<unknown>",
  ConnectedLineName: "<unknown>",
  Context: "messages",
  Exten: "h",
  Priority: "2",
  Uniqueid: "1788305013.58084",
  Linkedid: "1788305013.58084",
  Application: "Hangup",
  ApplicationData: "",
  Duration: "163:53:21",
};

test("isPseudoChannel: only Message/* — Local/ helpers stay ordinary helpers", () => {
  assert.equal(isPseudoChannel("Message/ast_msg_queue"), true);
  assert.equal(isPseudoChannel("  Message/ast_msg_queue"), true);
  assert.equal(isPseudoChannel("Local/105@T18_ring-group-dial-000056a8;1"), false);
  assert.equal(isPseudoChannel("PJSIP/T18_105_1-0000b8bb"), false);
  assert.equal(isPseudoChannel(""), false);
  // The wider helper classification is unchanged.
  assert.equal(isHelperChannel("Message/ast_msg_queue"), true);
  assert.equal(isHelperChannel("Local/105@T18_ring-group-dial-000056a8;1"), true);
});

test("CoreShowChannel for Message/ast_msg_queue creates no call and broadcasts nothing", () => {
  const { svc, calls, upserts } = makeService();
  dispatch(svc, MESSAGE_QUEUE_FRAME);
  assert.equal(calls.getAll().length, 0, "pseudo-channel must not enter the store");
  assert.equal(upserts.length, 0, "no callUpsert may reach the broadcaster");
});

test("a second bootstrap replay (AMI reconnect) still creates nothing", () => {
  const { svc, calls, upserts } = makeService();
  dispatch(svc, MESSAGE_QUEUE_FRAME);
  dispatch(svc, MESSAGE_QUEUE_FRAME);
  dispatch(svc, { ...MESSAGE_QUEUE_FRAME, Event: "Newchannel" });
  assert.equal(calls.getAll().length, 0);
  assert.equal(upserts.length, 0);
});

test("a real pre-existing PJSIP channel is still seeded by CoreShowChannel", () => {
  const { svc, calls, upserts } = makeService();
  dispatch(svc, {
    Event: "CoreShowChannel",
    Channel: "PJSIP/T18_105_1-0000b8bb",
    ChannelState: "6",
    ChannelStateDesc: "Up",
    CallerIDNum: "105",
    CallerIDName: "Mrs. Halpert",
    ConnectedLineNum: "8453042418",
    ConnectedLineName: "",
    Context: "trk-72-dial",
    Exten: "8453042418",
    Priority: "1",
    Uniqueid: "1788888977.92421",
    Linkedid: "1788888977.92421",
  });
  assert.equal(calls.getAll().length, 1, "the guard is narrow: real channels still seed");
  assert.equal(calls.getAll()[0]?.channels[0], "PJSIP/T18_105_1-0000b8bb");
  assert.ok(upserts.length >= 1, "real channels still broadcast");
});

test("a Local/ helper leg with a linkedid still attaches to its call (guard is Message/-only)", () => {
  const { svc, calls } = makeService();
  dispatch(svc, {
    Event: "Newchannel",
    Channel: "PJSIP/344022_Comfortcont-0000bc50",
    ChannelState: "6",
    ChannelStateDesc: "Up",
    CallerIDNum: "8456627835",
    CallerIDName: "",
    ConnectedLineNum: "",
    ConnectedLineName: "",
    Context: "T18_ext-ringgroups",
    Exten: "806",
    Priority: "1",
    Uniqueid: "1788895001.94659",
    Linkedid: "1788895001.94659",
  });
  dispatch(svc, {
    Event: "Newchannel",
    Channel: "Local/105@T18_ring-group-dial-000056a8;1",
    ChannelState: "0",
    ChannelStateDesc: "Down",
    CallerIDNum: "806",
    CallerIDName: "",
    ConnectedLineNum: "",
    ConnectedLineName: "",
    Context: "T18_ring-group-dial",
    Exten: "806",
    Priority: "1",
    Uniqueid: "1788895006.94662",
    Linkedid: "1788895001.94659",
  });
  const call = calls.getAll()[0];
  assert.ok(call);
  assert.equal(calls.getAll().length, 1);
  assert.ok(call.channels.includes("Local/105@T18_ring-group-dial-000056a8;1"), "Local legs still index onto the call");
});
