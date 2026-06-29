import { test } from "node:test";
import assert from "node:assert/strict";

import { mapAmiFrame } from "./AmiEventMapper";
import type { AmiDialBegin } from "./AmiTypes";

// Regression (2026-06-29): AMI `DialBegin` carries the dialed channel in the
// `DestChannel` field — there is NO `Destination` field on DialBegin. The
// mapper previously read `g("Destination")`, so `destination` was always "",
// `isExtensionLegChannel(destination)` was always false, and CallStateStore
// never captured the Mode-B cold-answer evidence (extLegAor/extLegDialedAt/
// extLegDialContext/extLegDialExten/extLegDialedContacts). This proves the
// mapper now populates `destination` from `DestChannel`.
test("mapAmiFrame DialBegin populates destination from DestChannel (not Destination)", () => {
  // Exact shape of the production frame that broke Mode-B (call 1782770820.148029,
  // ext 110 / AOR T2_110_1): a Local channel Dial()s the PJSIP extension leg.
  const frame: Record<string, string> = {
    Event: "DialBegin",
    Channel: "Local/110@T2_ivr-only-extensions-00006e0b;2",
    DestChannel: "PJSIP/T2_110_1-0001489d",
    DestUniqueid: "1782770831.148034",
    DialString:
      "T2_110_1/sip:8hkh5htv@50.49.194.85:39240;transport=ws;x-ast-orig-host=fegp85rdeme4.invalid:0",
    CallerIDNum: "8457823064",
    CallerIDName: "",
    Uniqueid: "1782770831.148033",
    Linkedid: "1782770820.148029",
    Context: "sub-local-dialing",
    Exten: "110",
  };

  const mapped = mapAmiFrame(frame);
  assert.ok(mapped, "DialBegin frame should map to a typed event");
  assert.equal(mapped!.event, "DialBegin");

  const dial = mapped as AmiDialBegin;
  // The load-bearing assertion: destination MUST be the dialed PJSIP extension
  // leg, taken from DestChannel.
  assert.equal(dial.destination, "PJSIP/T2_110_1-0001489d");
  // And the rest of the fields the Mode-B capture depends on.
  assert.equal(
    dial.dialString,
    "T2_110_1/sip:8hkh5htv@50.49.194.85:39240;transport=ws;x-ast-orig-host=fegp85rdeme4.invalid:0",
  );
  assert.equal(dial.context, "sub-local-dialing");
  assert.equal(dial.exten, "110");
  assert.equal(dial.channel, "Local/110@T2_ivr-only-extensions-00006e0b;2");
  assert.equal(dial.destUniqueid, "1782770831.148034");
});

// Guard against regressing to the old behavior: a frame that ONLY has a
// (nonexistent in real life) `Destination` field must NOT be where we read the
// dialed channel from — destination should come from DestChannel and stay empty
// when DestChannel is absent.
test("mapAmiFrame DialBegin does not read the non-existent Destination field", () => {
  const frame: Record<string, string> = {
    Event: "DialBegin",
    Channel: "Local/110@T2_ivr-only-extensions-00006e0b;2",
    Destination: "PJSIP/should-not-be-used",
    DialString: "T2_110_1/sip:abc@host",
    Uniqueid: "1.1",
    Linkedid: "1.1",
    Context: "sub-local-dialing",
    Exten: "110",
  };

  const mapped = mapAmiFrame(frame) as AmiDialBegin;
  assert.notEqual(mapped.destination, "PJSIP/should-not-be-used");
  assert.equal(mapped.destination, "");
});
