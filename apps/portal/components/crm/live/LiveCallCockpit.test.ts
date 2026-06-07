import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "components/crm/live/LiveCallCockpit.tsx"), "utf8");

test("LiveCallCockpit does not render duplicate dialer controls", () => {
  assert.doesNotMatch(source, /\btoggleMute\b|\btoggleHold\b|\bhangup\b|\bsendDtmf\b|\bsetKeypadOpen\b|\bsetTransferOpen\b|\btransferTarget\b|label="Keypad"|label="Transfer"|label="End Call"/);
});

test("LiveCallCockpit exposes the transcription placeholder without fake transcript data", () => {
  assert.match(source, /Transcript will appear here after the recorded call is processed\./);
  assert.doesNotMatch(source, /fake transcript|mock transcript|sample transcript/i);
});

test("LiveCallCockpit renders completed transcript intelligence states", () => {
  assert.match(source, /Transcript ready/);
  assert.match(source, /Action items/);
  assert.match(source, /<summary className="cursor-pointer text-sm font-semibold text-crm-text">Transcript<\/summary>/);
});

test("LiveCallCockpit renders failed and processing transcript states safely", () => {
  assert.match(source, /Processing recording/);
  assert.match(source, /Transcription failed/);
  assert.doesNotMatch(source, /recordingPath|pbxFilePath|gcsUri/);
});
