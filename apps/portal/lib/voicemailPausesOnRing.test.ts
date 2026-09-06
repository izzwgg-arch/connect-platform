/**
 * A playing voicemail must be silenced by an incoming RING (and a dial / a
 * connected call) on BOTH portal voicemail players — the full voicemail page
 * and the mini dialer's player.
 *
 * Fixup Group, 2026-09-06: "a voicemail was playing, a call came in, and the
 * voicemail didn't stop." Neither player consulted the phone at all; the
 * defect is a missing effect in a COMPONENT, so this guard reads the source.
 * Replay against the pre-fix tree with PORTAL_GUARD_ROOT=<path> — every
 * assertion below must fail there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function readSource(rel: string): string {
  const root = process.env.PORTAL_GUARD_ROOT ?? path.resolve(__dirname, "..");
  return readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function playerBlock(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found: ${endMarker}`);
  return stripLineComments(src.slice(start, end));
}

const PAUSE_ON_CALL =
  /const callIsActive =\s*phone\?\.callState === "ringing" \|\| phone\?\.callState === "dialing" \|\| phone\?\.callState === "connected";[\s\S]*?useEffect\(\(\) => \{\s*if \(callIsActive && audioRef\.current && !audioRef\.current\.paused\) \{\s*audioRef\.current\.pause\(\);/;

test("voicemail page: SmartAudioPlayer pauses its <audio> when the phone rings", () => {
  const src = readSource("app/(platform)/voicemail/page.tsx");
  assert.ok(
    /import \{ useOptionalSipPhone, useSipPhone \} from "\.\.\/\.\.\/\.\.\/hooks\/useSipPhone"/.test(src),
    "page must import useOptionalSipPhone",
  );
  const block = playerBlock(src, "function SmartAudioPlayer(", "\nexport default function VoicemailPage(");
  assert.ok(block.includes("const phone = useOptionalSipPhone();"), "player must read the phone");
  assert.ok(PAUSE_ON_CALL.test(block), "player must pause on ringing/dialing/connected");
});

test("mini dialer: VoicemailPlayer pauses its <audio> when the phone rings", () => {
  const src = readSource("components/DesktopMiniDialer.tsx");
  assert.ok(
    /import \{ useOptionalSipPhone, useSipPhone \} from "\.\.\/hooks\/useSipPhone"/.test(src),
    "mini dialer must import useOptionalSipPhone",
  );
  const block = playerBlock(src, "function VoicemailPlayer(", "\n  const seek = (value: number) => {");
  assert.ok(block.includes("const phone = useOptionalSipPhone();"), "player must read the phone");
  assert.ok(PAUSE_ON_CALL.test(block), "player must pause on ringing/dialing/connected");
});
