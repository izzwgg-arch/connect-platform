/**
 * Guards on the SignalWire onboarding wizard (2026-08-30 mockups build).
 *
 * The one that must never regress: ⛔ THE EIN IS NEVER AUTOSAVED. The
 * "never saved on your Loopcom account" promise is kept by STRUCTURE — the EIN
 * lives in its own useState outside FormData, and the autosave payload names
 * its keys explicitly, so neither the draft nor the answers can ever carry it.
 * These tests read the SOURCE because the defect they guard against is a
 * caller-side edit (moving ein into `form`, or adding `texting`/`ein` to the
 * autosave body) that every unit test of the components would sail past.
 *
 * Sources are CRLF-normalised; negative matches run on comment-stripped text
 * (the doc comments quote the forbidden patterns).
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

function readSrc(rel: string): string {
  return readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
}
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const page = readSrc("app/onboarding/[token]/page.tsx");
const texting = readSrc("app/onboarding/[token]/textingStep.tsx");
const mobile = readSrc("app/onboarding/[token]/mobileWizard.tsx");

test("the EIN lives OUTSIDE FormData — its own useState, never a form field", () => {
  assert.ok(page.includes('const [ein, setEin] = useState("")'), "ein is its own state");
  // FormData's declaration block must not carry an ein member.
  const typeStart = page.indexOf("type FormData = {");
  const typeEnd = page.indexOf("};", typeStart);
  const formType = page.slice(typeStart, typeEnd);
  assert.ok(!/\bein\b/i.test(stripComments(formType)), "FormData carries no ein");
});

test("the autosave payload names its keys and carries NEITHER texting NOR ein", () => {
  const saveStart = page.indexOf("answers: {", page.indexOf("const scheduleAutosave"));
  const saveEnd = page.indexOf("},", page.indexOf("addons:", saveStart));
  const body = stripComments(page.slice(saveStart, saveEnd));
  assert.ok(body.includes("company:") && body.includes("addons:"), "found the autosave body");
  assert.ok(!/\bein\b/i.test(body), "autosave never carries the EIN");
  assert.ok(!/\btexting\b/.test(body), "texting answers are written only by the registration POST (without the EIN)");
});

test("the registration POST is the ONE place the EIN leaves the browser", () => {
  assert.strictEqual(page.split("texting-registration").length - 1, 1, "one call site in the page");
  assert.ok(page.includes("buildTextingRegistrationPayload(f.texting, ein)"), "posts through the shared builder");
  const builder = texting.slice(texting.indexOf("export function buildTextingRegistrationPayload"));
  assert.ok(builder.includes("ein: t.noEin ? undefined : ein.trim()"), "sole-prop path sends no EIN");
});

test("the EIN input never autofills or persists (autoComplete off, disabled on the no-EIN path)", () => {
  const einInput = texting.slice(texting.indexOf('placeholder="82-1234567"') - 400, texting.indexOf('placeholder="82-1234567"') + 400);
  assert.ok(einInput.includes('autoComplete="off"'));
  assert.ok(einInput.includes("disabled={t.noEin}"));
});

test("desktop and mobile share ONE side-effect implementation (no forked apply-number / registration)", () => {
  // The mobile wizard must call the page's closures, never apiPost itself.
  assert.ok(!stripComments(mobile).includes("apiPost"), "mobile has no direct API writes");
  assert.ok(mobile.includes("wiz.fileTexting()"), "mobile files texting through the page's closure");
  assert.ok(mobile.includes("wiz.fireApplyNumber()"), "mobile applies the number through the page's closure");
  assert.ok(mobile.includes("wiz.handleSubmit()"), "mobile submits through the page's closure");
  // And the page routes BOTH paths through the same helpers.
  assert.ok(page.includes("fireApplyNumber(form)") && page.includes("fileTextingRegistration(form)"));
});

test("the phone is detected by SCREEN, not user agent, and renders the micro-step wizard", () => {
  assert.ok(page.includes('window.matchMedia("(max-width: 640px)")'));
  assert.ok(page.includes("<MobileWizard"), "the mobile branch renders");
  assert.ok(!/navigator\.userAgent/.test(stripComments(page)), "no user-agent games");
});

test("every SignalWire search mode is offered, letters are explained, and the port step is signed", () => {
  for (const m of ['"areacode"', '"starts"', '"contains"', '"ends"']) {
    assert.ok(page.includes(m), `mode ${m} present`);
  }
  assert.ok(page.includes("Letters work too"), "the T9 hint is on the desktop search");
  assert.ok(page.includes("loaSignature"), "the typed LOA signature exists");
  assert.ok(page.includes("Sign the transfer authorization by typing your full name."), "the signature is required for a port");
});

test("the registration card carries the promises in writing", () => {
  assert.ok(texting.includes("Your EIN is never saved on your Loopcom account."));
  assert.ok(texting.includes("silently block your messages"), "the why-we-ask explainer names the real risk");
  assert.ok(texting.includes("Reply STOP to opt out"), "the opt-out promise");
  assert.ok(texting.includes("I authorize"), "the consent line");
  assert.ok(texting.includes("2,000 messages a day"), "the class cap is stated");
});
