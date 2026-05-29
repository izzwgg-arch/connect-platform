import assert from "node:assert/strict";
import test from "node:test";
import { selectPlaybackChannelName } from "./telephonyPlaybackHelpers";

test("selectPlaybackChannelName prefers trunk leg for external playback", () => {
  const channel = selectPlaybackChannelName([
    "Local/100@from-internal-0001;1",
    "PJSIP/T2_103-00000022",
    "PJSIP/12345_trunk-00000023",
  ], "external");
  assert.equal(channel, "PJSIP/12345_trunk-00000023");
});

test("selectPlaybackChannelName can target the agent leg", () => {
  const channel = selectPlaybackChannelName([
    "PJSIP/T2_103-00000022",
    "PJSIP/12345_trunk-00000023",
  ], "agent");
  assert.equal(channel, "PJSIP/T2_103-00000022");
});
