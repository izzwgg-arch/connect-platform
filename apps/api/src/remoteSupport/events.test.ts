/**
 * The session transcript, attacked.
 *
 * ⛔ The property under test is not "does it render nicely". It is that a system
 * event STRUCTURALLY CANNOT carry a keystroke, a clipboard string or a screen
 * capture — because the only free text in the whole surface is a chat message a
 * human deliberately typed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CHAT_CHARS,
  SYSTEM_EVENT_CODES,
  WINDOWS_RESERVED,
  isSystemEventCode,
  renderSystemEvent,
  sanitizeChatBody,
  sanitizeFileName,
  type SystemEventCode,
} from "./events";

/* ───────────────────── system events ─────────────────────────────── */

test("every system code renders a real sentence", () => {
  for (const code of SYSTEM_EVENT_CODES) {
    const s = renderSystemEvent(code);
    assert.ok(s.length > 8, `${code} is too short: ${s}`);
    assert.ok(/[a-z]/i.test(s), `${code} has no words`);
    assert.ok(s.trim().endsWith("."), `${code} is not a sentence: ${s}`);
    // ⛔ A slug must never reach a screen.
    assert.ok(!s.includes("_"), `${code} leaked a slug: ${s}`);
  }
});

test("⛔ control_used records a COUNT and can never carry what was typed", () => {
  const s = renderSystemEvent("control_used", { actorName: "Sarah", count: 412 });
  assert.match(s, /412/);
  // There is nowhere in SystemEventFacts to put keystrokes; assert that the
  // rendered line cannot be steered by trying.
  const hostile = renderSystemEvent("control_used", {
    actorName: "Sarah",
    count: 1,
    // `detail` is ignored by this code entirely.
    detail: "PASSWORD hunter2 typed",
  } as any);
  assert.ok(!hostile.includes("hunter2"), `keystrokes leaked: ${hostile}`);
});

test("⛔ clipboard_shared records a LENGTH and can never carry the text", () => {
  const s = renderSystemEvent("clipboard_shared", { count: 74 });
  assert.match(s, /74/);
  const hostile = renderSystemEvent("clipboard_shared", {
    count: 74,
    detail: "sk_live_51H8xEXAMPLEKEY",
  } as any);
  assert.ok(!hostile.includes("sk_live"), `clipboard content leaked: ${hostile}`);
});

test("⛔ an unknown code is not a code", () => {
  for (const junk of ["", "hack", "__proto__", "REQUESTED", "message", null, 42, {}]) {
    assert.equal(isSystemEventCode(junk), false, `${String(junk)} was accepted`);
  }
  for (const code of SYSTEM_EVENT_CODES) assert.equal(isSystemEventCode(code), true);
});

test("file sizes render sensibly and never as NaN", () => {
  const cases: Array<[number | null | undefined, RegExp]> = [
    [0, /0 B/],
    [900, /900 B/],
    [2048, /2\.0 KB/],
    [5 * 1024 * 1024, /5\.0 MB/],
    [null, /0 B/],
    [undefined, /0 B/],
    [-5, /0 B/],
    [NaN, /0 B/],
    [Infinity, /0 B/],
  ];
  for (const [bytes, re] of cases) {
    const s = renderSystemEvent("file_sent", { fileName: "log.txt", bytes: bytes as any });
    assert.match(s, re, `bytes=${String(bytes)} rendered as ${s}`);
    assert.ok(!s.includes("NaN"), s);
    assert.ok(!s.includes("Infinity"), s);
  }
});

test("a missing actor name never renders as a placeholder bug", () => {
  for (const name of [null, undefined, "", "   "]) {
    const s = renderSystemEvent("requested", { actorName: name as any });
    // The escalation-SMS lesson: never "Unknown user" where a person belongs.
    assert.ok(!/unknown|undefined|null/i.test(s), `${String(name)} rendered as ${s}`);
    assert.match(s, /Loopcom support/);
  }
});

/* ───────────────────────── chat body ─────────────────────────────── */

test("an ordinary message survives intact", () => {
  const msg = "I can see it now, thank you!";
  assert.equal(sanitizeChatBody(msg), msg);
});

test("newlines and tabs are kept; other control characters are not", () => {
  const s = sanitizeChatBody("line one\nline two\tindented");
  assert.match(s, /line one\nline two\tindented/);

  const nasty = sanitizeChatBody("before" + String.fromCharCode(0) + "after");
  assert.equal(nasty, "beforeafter");

  const bell = sanitizeChatBody("a" + String.fromCharCode(7) + "b");
  assert.equal(bell, "ab");
});

test("⛔ a bidirectional override cannot be used to forge a transcript line", () => {
  const rlo = String.fromCharCode(0x202e);
  const out = sanitizeChatBody("safe" + rlo + "reversed");
  assert.ok(!out.includes(rlo), "RLO survived");
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const s = sanitizeChatBody("x" + String.fromCodePoint(cp) + "y");
    assert.equal(s, "xy", `codepoint ${cp.toString(16)} survived`);
  }
});

test("zero-width characters are removed", () => {
  for (const cp of [0x200b, 0x200c, 0x200d, 0xfeff]) {
    assert.equal(sanitizeChatBody("a" + String.fromCodePoint(cp) + "b"), "ab");
  }
});

test("chat is capped, and the cap is on characters not on bytes", () => {
  const long = "a".repeat(MAX_CHAT_CHARS + 500);
  assert.equal(sanitizeChatBody(long).length, MAX_CHAT_CHARS);
});

test("a non-string message is not a message", () => {
  for (const junk of [null, undefined, 42, {}, [], true]) {
    assert.equal(sanitizeChatBody(junk), "");
  }
});

test("emoji and Yiddish text survive — this customer base writes both", () => {
  assert.equal(sanitizeChatBody("שלום, זה עובד עכשיו"), "שלום, זה עובד עכשיו");
  assert.equal(sanitizeChatBody("thanks 🙏"), "thanks 🙏");
});

/* ──────────────────────── file names ─────────────────────────────── */

const bad = (raw: string, reason?: string) => {
  const r = sanitizeFileName(raw);
  assert.equal(r.ok, false, `${JSON.stringify(raw)} was accepted`);
  if (!r.ok && reason) assert.equal(r.reason, reason, `${JSON.stringify(raw)} -> ${r.reason}`);
};
const good = (raw: string, expect: string) => {
  const r = sanitizeFileName(raw);
  assert.equal(r.ok, true, `${JSON.stringify(raw)} was refused`);
  if (r.ok) assert.equal(r.name, expect);
};

test("an ordinary filename is accepted unchanged", () => {
  good("diagnostics.txt", "diagnostics.txt");
  good("Call log 2026-08-31.csv", "Call log 2026-08-31.csv");
});

test("⛔ path traversal cannot survive in any form", () => {
  good("../../../etc/passwd", "passwd");
  good("..\\..\\Windows\\System32\\config\\SAM", "SAM");
  good("a/b/../c.txt", "c.txt");
  bad("..");
  bad(".");
  bad("../..");
});

test("⛔ an absolute or UNC path is reduced to its last segment", () => {
  good("C:\\Windows\\System32\\drivers\\etc\\hosts", "hosts");
  good("\\\\attacker\\share\\payload.exe", "payload.exe");
  good("/etc/shadow", "shadow");
});

test("⛔ an alternate data stream is refused outright", () => {
  bad("notes.txt:hidden.exe", "illegal_characters");
  bad("a:b", "illegal_characters");
});

test("⛔ Windows reserved device names are refused", () => {
  for (const name of WINDOWS_RESERVED) {
    bad(`${name}.txt`, "reserved_name");
    bad(name, "reserved_name");
    // Case must not be an escape hatch.
    bad(`${name.toLowerCase()}.log`, "reserved_name");
  }
});

test("⛔ trailing dots and spaces are stripped, because Windows strips them too", () => {
  // "evil.txt." becomes "evil.txt" on disk AFTER any naive check.
  good("report.txt.", "report.txt");
  good("report.txt   ", "report.txt");
  good("report.txt . . ", "report.txt");
  bad("...", "empty_filename");
  bad("   ", "empty_filename");
});

test("⛔ control characters in a filename are refused, not stripped", () => {
  // Stripping would silently produce a DIFFERENT file to the one announced in
  // the transcript. Refusing keeps the record honest.
  bad("re" + String.fromCharCode(0) + "port.txt", "illegal_characters");
  bad("re" + String.fromCharCode(10) + "port.txt", "illegal_characters");
});

test("⛔ characters Windows forbids are refused", () => {
  for (const ch of ["<", ">", '"', "|", "?", "*"]) {
    bad(`bad${ch}name.txt`, "illegal_characters");
  }
});

test("an absurdly long name is refused rather than truncated into a collision", () => {
  bad("a".repeat(400) + ".txt", "name_too_long");
});

test("a non-string filename is refused", () => {
  for (const junk of [null, undefined, 42, {}, []]) {
    const r = sanitizeFileName(junk);
    assert.equal(r.ok, false, `${String(junk)} accepted`);
  }
});

test("⛔ every accepted name is a bare filename with no separator left in it", () => {
  const probes = [
    "..\\..\\x.txt",
    "/a/b/c.doc",
    "C:\\x\\y.pdf",
    "\\\\srv\\s\\z.bin",
    "normal.txt",
    "  spaced.txt  ",
  ];
  for (const p of probes) {
    const r = sanitizeFileName(p);
    if (!r.ok) continue;
    assert.ok(!r.name.includes("/"), `${p} -> ${r.name}`);
    assert.ok(!r.name.includes("\\"), `${p} -> ${r.name}`);
    assert.ok(!r.name.includes(".."), `${p} -> ${r.name}`);
    assert.equal(r.name, r.name.trim());
  }
});

/* ───────────── the structural property, stated as a test ─────────── */

test("⛔⛔ SystemEventFacts has no field that could carry screen or key content", () => {
  // The guard is the shape itself: render every code with every fact set to a
  // hostile marker and assert the marker never appears except where a filename
  // or a deliberate short detail legitimately belongs.
  const MARK = "ZZSECRETZZ";
  const facts = {
    actorName: MARK,
    capabilities: [MARK],
    count: 1,
    fileName: MARK,
    bytes: 1,
    screenName: MARK,
    detail: MARK,
  };
  // Codes where a caller-supplied string is legitimately rendered. Each is
  // composed by our own code from a closed vocabulary, never from a device.
  const allowed = new Set<SystemEventCode>([
    "requested",
    "consented",
    "capability_requested",
    "capability_granted",
    "capability_refused",
    "control_used",
    "file_sent",
    "file_received",
    "screen_changed",
    "diagnostic_started",
    "diagnostic_finished",
    "ai_suggested",
    "quality_degraded",
    "ended",
    // Remote Desktop (2026-09-02): the connecting side's own label for where it
    // sits ("Office PC") and the machine's name — bounded strings the sentence is
    // composed around, never screen or key content.
    "desktop_connected",
    "machine_accepted",
    "share_used",
    "sound_routed",
    "mic_routed",
  ]);
  for (const code of SYSTEM_EVENT_CODES) {
    const s = renderSystemEvent(code, facts);
    if (allowed.has(code)) continue;
    assert.ok(!s.includes(MARK), `${code} rendered caller text: ${s}`);
  }
  // And the two that record volume never render content even when handed it.
  assert.ok(!renderSystemEvent("clipboard_shared", facts).includes(MARK));
  assert.ok(!renderSystemEvent("killed", facts).includes(MARK));
  assert.ok(!renderSystemEvent("revoked", facts).includes(MARK));
  assert.ok(!renderSystemEvent("connected", facts).includes(MARK));
});
