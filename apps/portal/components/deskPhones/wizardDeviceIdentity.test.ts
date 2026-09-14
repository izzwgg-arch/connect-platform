/**
 * The wizard asks "what device did we discover?", never "what brand did you pick?".
 *
 * ⛔ These read SOURCE on purpose, like the neighbouring wizard guards: every defect they
 * catch is a caller or a piece of JSX — a scan that forgets to say how a device named
 * itself, a card that hides the address, a label box that never reaches the server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(relative: string): string {
  const root = process.env.PORTAL_GUARD_ROOT || join(__dirname);
  return readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

/** ⛔ Comment-stripped: the prose quotes shapes it forbids. */
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

test("the scan says HOW each device named itself, so the server can file it as a source", () => {
  const src = wizard();
  const post = src.slice(src.indexOf("const found = verdict.phones.map"));
  assert.match(post.slice(0, 700), /identitySource:/);
  assert.match(post.slice(0, 700), /fingerprint\?\.source/);
});

test("a found device's card shows what it is and where it is", () => {
  const src = wizard();
  assert.match(src, /ip\?: string \| null;/);
  assert.match(src, /deviceTypeLabel\?: string \| null;/);
  assert.match(src, /\[p\.mac, p\.ip\]\.filter\(Boolean\)/, "the network address rides beside the hardware address");
  assert.match(src, /hardwareLine\(p\)/, "the kind of device is named on the row");
});

test("only a device we could not name is asked what it is", () => {
  assert.match(wizard(), /step === "match" && needsIdentifying\(p\)/);
});

test("a label can be typed or scanned, and it reaches the server", () => {
  const src = wizard();
  const fn = src.slice(src.indexOf("const scanLabel = useCallback"));
  const body = fn.slice(0, fn.indexOf("}, [runId, loadRun]);"));
  assert.match(body, /phones\/\$\{phoneId\}\/scan-label/);
  assert.match(body, /loadRun\(runId\)/, "the row must show what the label changed");
  assert.match(body, /err\?\.body\?\.message/);
  assert.doesNotMatch(body, /\.payload/);
  assert.match(body, /setIdentifyError/, "a refusal belongs on that device's own row");
  assert.doesNotMatch(body, /setError\(/);
  assert.match(src, /void scanLabel\(p\.id/);
});

test("the setup driver's report of a delivered folder is untouched", () => {
  assert.doesNotMatch(executable(readSource("setupDriver.ts")), /identitySource/);
});
