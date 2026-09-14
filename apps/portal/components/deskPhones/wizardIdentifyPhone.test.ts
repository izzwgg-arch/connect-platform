/**
 * Telling us what a phone is — the control that answers `model_unknown`.
 *
 * ⛔⛔ WHY IT EXISTS. A phone the fingerprint could not name has no catalogue row, so the
 * phone system writes no `provisioning.devices` row, so the standing PnP listener has
 * nothing to answer, so a factory-reset handset multicasts its request and is met with
 * silence. `planProvisioningRecord` has answered that with "Tell us the make and model on
 * the back of this phone and we can set it up" since the day it shipped — at somebody who
 * had nowhere to say it. Izzy's own Yealink sat in exactly that state.
 *
 * ⛔ These read SOURCE on purpose. Every defect this file guards is a CALLER or a piece of
 * JSX — a picker that never reaches the server, a refusal read off the wrong field, a
 * question asked of a phone that already told us — and nothing that calls a function can
 * see any of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(relative: string): string {
  // PORTAL_GUARD_ROOT replays these against an export of HEAD, so they are PROVEN to fail
  // on the pre-change code rather than assumed to.
  const root = process.env.PORTAL_GUARD_ROOT || join(__dirname);
  return readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

/** ⛔ Comment-stripped: this file's own prose quotes several shapes it forbids. */
function executable(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const wizard = () => executable(readSource("DeskPhoneWizard.tsx"));
const picker = () => executable(readSource("PhoneIdentity.tsx"));

/* ── the answer reaches the server ───────────────────────────────────────── */

test("the pickers actually post the answer — the whole point of asking", () => {
  assert.match(
    wizard(),
    /phones\/\$\{phoneId\}\/identify/,
    "a picker that only sets local state leaves the phone exactly as unfinishable as before",
  );
});

test("the row is reloaded afterwards, so the screen shows what changed", () => {
  const src = wizard();
  const fn = src.slice(src.indexOf("const identify = useCallback"));
  const body = fn.slice(0, fn.indexOf("}, [runId, loadRun]);"));
  assert.match(body, /identify`[\s\S]{0,400}loadRun\(runId\)/, "otherwise it reads as nothing happening");
});

/* ── the refusal reaches the person ──────────────────────────────────────── */

test("the server's sentence is read off `.body`, never the `.payload` that does not exist", () => {
  const src = wizard();
  const fn = src.slice(src.indexOf("const identify = useCallback"));
  const body = fn.slice(0, fn.indexOf("}, [runId, loadRun]);"));
  assert.match(body, /err\?\.body\?\.message/, "ApiError exposes the server JSON as `body`");
  assert.doesNotMatch(body, /\.payload/, "`.payload` has never existed and silently yields a bare slug");
});

test("a refusal is shown on that phone's own row, not as a page-wide error", () => {
  const src = wizard();
  const fn = src.slice(src.indexOf("const identify = useCallback"));
  const body = fn.slice(0, fn.indexOf("}, [runId, loadRun]);"));
  assert.match(body, /setIdentifyError/, "with several phones listed, a message at the top names none of them");
  assert.doesNotMatch(body, /setError\(/, "the page-wide error would not say which phone it is about");
});

/* ── who gets asked ──────────────────────────────────────────────────────── */

test("only a phone we genuinely cannot name is asked", () => {
  assert.match(
    wizard(),
    /step === "match" && needsIdentifying\(p\)/,
    "asking about a phone that told us its own model reads as the wizard not paying attention",
  );
});

test("the drawing of where the label sits is shown with the question", () => {
  // ⛔ The picture is the half people actually need: almost nobody knows their phone's
  // model, almost everybody can read a label once they are told it is UNDERNEATH.
  const src = wizard();
  assert.match(src, /<StickerDrawing \/>/);
  assert.equal(
    (src.match(/<StickerDrawing \/>/g) ?? []).length,
    2,
    "both places the question is asked: the up-front step and a single phone's row",
  );
});

/* ── the lists themselves ────────────────────────────────────────────────── */

test("changing the make clears the model", () => {
  // ⛔ The model list is about to be replaced; a model left behind from another brand is
  // the one combination the server refuses, and it would refuse something the person
  // never actually picked.
  const src = picker();
  const onMake = src.slice(src.indexOf("onChange={(v) => {"));
  assert.match(onMake.slice(0, 260), /onMake\(v\);[\s\S]{0,200}onModel\(""\)/);
});

test("a model we cannot set up is OFFERED and says so, never hidden", () => {
  // ⛔ Hiding it sends somebody hunting a list that silently does not contain their phone.
  assert.match(picker(), /o\.setupSupported \? o\.label :/);
});

test("nothing about a phone system leaks into what the person reads", () => {
  const src = picker();
  for (const jargon of ["pbxModelId", "provisioning.devices", "catalogue row", "VendorSlug"]) {
    assert.ok(!executable(src).includes(`"${jargon}`), `${jargon} must not reach a label`);
  }
});
