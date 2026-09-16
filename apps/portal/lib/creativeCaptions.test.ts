/**
 * Creative Studio — captions must stay in time with the voice.
 *
 * A caption that drifts is worse than no caption: the viewer reads the wrong
 * line while hearing another. These pin the two rules that keep it honest —
 * lines are cut where a person would pause, and the timings always add up to
 * exactly the audio that was actually spoken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { captionCues, captionLines } from "./creativeCaptions";

test("a script is cut at its sentences", () => {
  assert.deepEqual(captionLines("Your phones never sleep. Neither do we."), ["Your phones never sleep.", "Neither do we."]);
});

test("a sentence too long to read at once is broken on word boundaries", () => {
  const lines = captionLines(
    "When a customer calls your shop after hours and nobody picks up they simply call the next shop on the list instead.",
    42,
  );
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(line.length <= 42, `"${line}" is ${line.length} characters — too long to read`);
    assert.ok(!line.startsWith(" ") && !line.endsWith(" "), `"${line}" has loose whitespace`);
  }
  // Nothing may be lost or duplicated in the breaking.
  assert.equal(lines.join(" ").replace(/\s+/g, " "), "When a customer calls your shop after hours and nobody picks up they simply call the next shop on the list instead.");
});

test("a single word longer than the line is still shown rather than dropped", () => {
  const lines = captionLines("Supercalifragilisticexpialidocious.", 10);
  assert.equal(lines.join(""), "Supercalifragilisticexpialidocious.");
});

test("an empty script produces no captions rather than one blank one", () => {
  assert.deepEqual(captionLines(""), []);
  assert.deepEqual(captionLines("   \n  "), []);
});

test("messy spacing and line breaks are tidied, not carried into the picture", () => {
  assert.deepEqual(captionLines("Your phones\n\n  never sleep."), ["Your phones never sleep."]);
});

test("captions cover the spoken audio from beginning to end", () => {
  const cues = captionCues(["Your phones never sleep.", "Neither do we."], 6000);
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[cues.length - 1].endMs, 6000);
  for (let i = 1; i < cues.length; i += 1) {
    assert.equal(cues[i].startMs, cues[i - 1].endMs, "a gap or an overlap between captions reads as a glitch");
  }
});

test("a longer line is given longer on screen", () => {
  const [short, long] = captionCues(["Hi.", "A considerably longer line to read aloud."], 10000);
  assert.ok(long.endMs - long.startMs > short.endMs - short.startMs);
});

test("captions start where the voiceover starts, not where the film does", () => {
  const cues = captionCues(["One.", "Two."], 4000, 2500);
  assert.equal(cues[0].startMs, 2500);
  assert.equal(cues[cues.length - 1].endMs, 6500);
});

test("no caption flashes past faster than it can be read", () => {
  const cues = captionCues(captionLines("A. B. C. D. E. F. G. H."), 2000);
  for (const cue of cues) assert.ok(cue.endMs - cue.startMs >= 700, "a caption under 0.7s cannot be read");
});

test("one line takes the whole voiceover", () => {
  const cues = captionCues(["The only thing said."], 5000);
  assert.deepEqual(cues, [{ startMs: 0, endMs: 5000, text: "The only thing said." }]);
});

test("nothing to say means nothing burned in", () => {
  assert.deepEqual(captionCues([], 5000), []);
});
