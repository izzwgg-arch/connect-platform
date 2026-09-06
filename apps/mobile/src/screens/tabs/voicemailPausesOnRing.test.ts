/**
 * A playing voicemail must stop the moment a ring PUSH lands, not only when
 * the SIP INVITE reaches JsSIP (`sip.callState === "ringing"`).
 *
 * Fixup Group, 2026-09-06: "a voicemail was playing, a call came in, and it
 * didn't stop." On this app the ring screen is push-driven (incomingInvite);
 * the SIP INVITE can arrive seconds later or never (the stale-registration
 * failure), so a stop keyed on sip.callState alone lets the voicemail talk
 * over the ring. The defect is in the COMPONENT's condition, so this guard
 * reads the source. Replay with MOBILE_GUARD_ROOT=<pre-fix tree>.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function readSource(rel: string): string {
  const root = process.env.MOBILE_GUARD_ROOT ?? path.resolve(__dirname, "../../..");
  return readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

test("VoicemailTab stops playback on the push invite, not only on sip.callState", () => {
  const src = stripLineComments(readSource("src/screens/tabs/VoicemailTab.tsx"));
  assert.ok(
    src.includes("import { useIncomingNotifications } from '../../context/NotificationsContext';"),
    "VoicemailTab must import useIncomingNotifications",
  );
  assert.ok(src.includes("const notifications = useIncomingNotifications();"), "must read the notifications context");
  assert.ok(
    /const callIsActive =\s*sip\.callState === 'dialing' \|\| sip\.callState === 'ringing' \|\| sip\.callState === 'connected' \|\|\s*notifications\.incomingInvite !== null;/.test(src),
    "callIsActive must include notifications.incomingInvite",
  );
  assert.ok(
    /useEffect\(\(\) => \{\s*if \(callIsActive && activeIdRef\.current\) \{\s*stopPlayback\(\);/.test(src),
    "the stop effect must still key on callIsActive",
  );
});
