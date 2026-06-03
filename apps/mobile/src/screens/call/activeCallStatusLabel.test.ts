import test from "node:test";
import assert from "node:assert/strict";
import { activeCallStatusLabel } from "./activeCallStatusLabel.js";

test("answer handoff alone does not show CONNECTED", () => {
  assert.equal(
    activeCallStatusLabel({
      isEnded: false,
      isHoldState: false,
      isAnswerInFlight: true,
      callState: "idle",
    }),
    "ANSWERING…",
  );
});

test("CONNECTED only when SIP call state is connected", () => {
  assert.equal(
    activeCallStatusLabel({
      isEnded: false,
      isHoldState: false,
      isAnswerInFlight: false,
      callState: "connected",
    }),
    "CONNECTED",
  );
});

test("backend claim is not treated as SIP connected", () => {
  assert.equal(
    activeCallStatusLabel({
      isEnded: false,
      isHoldState: false,
      isAnswerInFlight: false,
      callState: "idle",
    }),
    "CONNECTING…",
  );
});
