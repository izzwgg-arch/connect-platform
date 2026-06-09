import assert from "node:assert/strict";
import test from "node:test";
import { classifyVoicemailDropLegs, isAgentLeg, isTrunkLeg } from "./voicemailDropLegs";

test("classifies trunk leg as customer and tenant endpoint as agent", () => {
  const legs = classifyVoicemailDropLegs([
    "Local/100@from-internal-0001;1",
    "PJSIP/T2_103-00000022",
    "PJSIP/344022_Vaddb-00000023",
  ]);
  assert.equal(legs.customerLeg, "PJSIP/344022_Vaddb-00000023");
  assert.equal(legs.agentLeg, "PJSIP/T2_103-00000022");
});

test("ignores Local/Message plumbing channels", () => {
  const legs = classifyVoicemailDropLegs([
    "Message/ast_msg_queue",
    "Local/abc@ctx;2",
    "PJSIP/T9_101-000000aa",
    "PJSIP/355362_Homevital-000000ab",
  ]);
  assert.equal(legs.customerLeg, "PJSIP/355362_Homevital-000000ab");
  assert.equal(legs.agentLeg, "PJSIP/T9_101-000000aa");
});

test("agent endpoint hint protects internal ext-to-ext calls", () => {
  // Two agent-style legs (no trunk). The far end must be the non-initiating ext.
  const legs = classifyVoicemailDropLegs(
    ["PJSIP/T3_302-00000a93", "PJSIP/T3_410-00000a94"],
    "T3_302",
  );
  assert.equal(legs.agentLeg, "PJSIP/T3_302-00000a93");
  assert.equal(legs.customerLeg, "PJSIP/T3_410-00000a94");
});

test("endpoint hint accepts full channel name form", () => {
  const legs = classifyVoicemailDropLegs(
    ["PJSIP/T3_302-00000a93", "PJSIP/344022_Vaddb-00000a94"],
    "PJSIP/T3_302-00000a93",
  );
  assert.equal(legs.agentLeg, "PJSIP/T3_302-00000a93");
  assert.equal(legs.customerLeg, "PJSIP/344022_Vaddb-00000a94");
});

test("returns nulls when no playable channels", () => {
  const legs = classifyVoicemailDropLegs(["Local/x@c;1", "Message/q"]);
  assert.equal(legs.customerLeg, null);
  assert.equal(legs.agentLeg, null);
});

test("single trunk-only call still yields a customer leg", () => {
  const legs = classifyVoicemailDropLegs(["PJSIP/344022_Vaddb-00000023"]);
  assert.equal(legs.customerLeg, "PJSIP/344022_Vaddb-00000023");
  assert.equal(legs.agentLeg, null);
});

test("isAgentLeg / isTrunkLeg discriminate the two endpoint shapes", () => {
  assert.equal(isAgentLeg("PJSIP/T3_302-00000a93"), true);
  assert.equal(isAgentLeg("PJSIP/344022_Vaddb-00000a93"), false);
  assert.equal(isTrunkLeg("PJSIP/344022_Vaddb-00000a93"), true);
  assert.equal(isTrunkLeg("PJSIP/T3_302-00000a93"), false);
});
