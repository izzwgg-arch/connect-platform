/**
 * Remote Desktop — the WIRING guards. These read source on purpose.
 *
 * Every defect of this shape in this repo has been a caller: a component mounted
 * without its gate, a page missing its nav entry, a permission rule that never
 * matched, a credential that took the URL instead of the encrypted channel. A
 * unit test of any one function passes straight through all of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.PORTAL_GUARD_ROOT ? String(process.env.PORTAL_GUARD_ROOT) : join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const exec = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");

test("the host is mounted globally AND gated on the desktop bridge's remoteDesktop key + the full window", () => {
  const providers = exec(read("app/providers.tsx"));
  assert.match(providers, /<RemoteDesktopHost\s*\/>/, "the machine side must run on every signed-in desktop window — it is how a computer becomes reachable");
  const host = exec(read("components/RemoteDesktopHost.tsx"));
  // ⛔ THE FLEET GATE. Without both halves, every browser tab and every mini
  // window would register itself as a machine and poll every five seconds.
  assert.match(host, /bridge\?\.remoteDesktop\?\.listScreens/, "the feature exists only where the Windows app published the host key");
  assert.match(host, /windowKind\s*===\s*"full"/, "only the window that runs the SIP engine may host — the mini is a proxy");
  assert.match(host, /if \(!supported\) return;/);
  assert.match(host, /return null;\s*}\s*$/, "the host renders nothing — the banner is the visible surface");
  // The poll is gated on a signed-in token (the auto-ban lesson: a signed-out tab polling an authenticated route bans the office).
  assert.match(host, /hasBrowserAuthToken\(\)/);
});

test("the screen is attached only after the login verdict, and the credentials never reach the server", () => {
  const host = exec(read("components/RemoteDesktopHost.tsx"));
  // The login frame goes to the desktop main process for the verdict; the
  // server gets reportLoginResult (ok / attemptsLeft / locked) and nothing else.
  assert.match(host, /remoteDesktop\?\.verifyLogin\?\.\(frame\.username, frame\.password\)/);
  assert.match(host, /reportLoginResult\(session\.id, identity\.machineKey, \{ ok: true \}\)/);
  assert.doesNotMatch(host, /reportLoginResult\([^)]*(username|password)/, "the verdict call must never carry the typed credential");
  // openUp() — control + screen — runs only after verdict.ok, or for an already-authenticated share session.
  const loginCase = host.slice(host.indexOf('case "login":'), host.indexOf('case "audio":'));
  assert.match(loginCase, /if \(verdict\.ok\)[\s\S]*await openUp\(session\)/);
  assert.doesNotMatch(loginCase.slice(0, loginCase.indexOf("if (verdict.ok)")), /openUp|shareScreen|enableControl/, "nothing opens before the verdict");
});

test("the viewer hands the own-computer login to the session page through sessionStorage, never the URL", () => {
  const home = exec(read("app/(platform)/remote-desktop/page.tsx"));
  assert.match(home, /sessionStorage\.setItem\(LOGIN_HANDOFF_KEY\(res\.session\.id\)/);
  assert.doesNotMatch(home, /router\.push\(`[^`]*(username|password)=/, "credentials in a URL land in history, logs and referers");
  const session = exec(read("app/(platform)/remote-desktop/session/[id]/page.tsx"));
  assert.match(session, /sessionStorage\.removeItem\(LOGIN_HANDOFF_KEY\(sessionId\)\)/, "one read, then gone");
  assert.match(session, /peer\.sendFrame\(\{ t: "login", username: u, password: p \}\)/, "the login rides the peer connection");
  assert.doesNotMatch(session, /apiPost\([^)]*password/, "no server call ever carries the password");
});

test("the peer pre-allocates its transceivers and swaps tracks in with replaceTrack — no renegotiation", () => {
  const peer = exec(read("services/remoteDesktop.ts"));
  assert.match(peer, /addTransceiver\("video", \{ direction: "sendonly" \}\)/);
  assert.match(peer, /addTransceiver\("audio", \{ direction: "sendonly" \}\)/);
  assert.match(peer, /addTransceiver\("audio", \{ direction: "recvonly" \}\)/);
  assert.match(peer, /replaceTrack\(/);
  assert.doesNotMatch(peer, /addTrack\(/, "addTrack after the offer would force a renegotiation the other side is not built for");
  // The host carries the machine key as a header, never in the body or the URL.
  assert.match(peer, /MACHINE_KEY_HEADER = "x-machine-key"/);
  assert.doesNotMatch(peer, /machineKey=/, "the key must not be a query parameter");
});

test("the external microphone reaches the SIP phone through ONE path, used by every call site", () => {
  const sip = exec(read("hooks/useSipPhone.ts"));
  assert.match(sip, /setExternalMicrophoneStream/);
  // dial, answer and answerSession all acquire the mic through acquireMicStream, so a
  // connected viewer's microphone is the phone's microphone on every call shape.
  const acquires = sip.match(/acquireMicStream\(\)/g) ?? [];
  assert.ok(acquires.length >= 3, `expected dial + answer + answerSession to acquire the microphone via one helper, found ${acquires.length}`);
  assert.doesNotMatch(sip.replace(/const acquireMicStream[\s\S]*?\n  \}, \[/, ""), /getUserMedia\(\{\s*audio:\s*(true|\{)/, "a stray getUserMedia bypasses the external-mic routing");
});

test("the page ships with its nav entry, its permission key and its API rule", () => {
  const nav = exec(read("navigation/navConfig.ts"));
  assert.match(nav, /id:\s*"workspace\.remote_desktop"[\s\S]{0,400}href:\s*"\/remote-desktop"[\s\S]{0,400}permission:\s*"can_use_remote_desktop"/);
  // The pages gate themselves on the SAME key the nav uses.
  for (const p of ["app/(platform)/remote-desktop/page.tsx", "app/(platform)/remote-desktop/this-computer/page.tsx"]) {
    assert.match(exec(read(p)), /<PermissionGate permission="can_use_remote_desktop">/, `${p} must gate on the nav key`);
  }
  const server = read("../api/src/server.ts");
  assert.match(server, /\{\s*prefix:\s*"\/remote-desktop",\s*permission:\s*null\s*\}/, "the prefix must MATCH a rule (permission: null) — the customer's machine polls it with no admin key");
  assert.doesNotMatch(server, /\{\s*prefix:\s*"\/remote-desktop",\s*permission:\s*"can_/, "gating the prefix on a permission 403s every machine's own poll");
  assert.match(server, /registerRemoteDesktopRoutes\(app, \{ audit \}\)/);
});

test("the shared permission keys exist and land in the right buckets", () => {
  const perms = exec(read("../../packages/shared/src/portalPermissions.ts"));
  for (const key of ["can_use_remote_desktop", "can_connect_by_id", "can_share_own_computer"]) assert.match(perms, new RegExp(`"${key}"`), `${key} missing from the catalog`);
  const endUser = perms.slice(perms.indexOf("END_USER_ACTIONS"), perms.indexOf("TENANT_ADMIN_EXTRA_ACTIONS"));
  assert.match(endUser, /"can_use_remote_desktop"/, "an ordinary user reaches their own computers");
  assert.doesNotMatch(endUser, /"can_connect_by_id"|"can_share_own_computer"/, "connect-by-ID and sharing are the owner's to grant");
});

test("the stage's controls are honest about what this version cannot do", () => {
  const session = exec(read("app/(platform)/remote-desktop/session/[id]/page.tsx"));
  assert.match(session, /Send a file<\/button>/);
  assert.match(session, /Ctrl\+Alt\+Del<\/button>/);
  // Both are rendered DISABLED with a reason — never a live button that fails.
  assert.match(session, /disabled title="Not in this version">Send a file/);
  assert.match(session, /disabled title="Windows refuses remote input on administrator prompts">Ctrl\+Alt\+Del/);
  // The lock-screen truth: black picture, typing refused, someone must unlock it there.
  assert.match(session, /Windows is locked on/);
  assert.match(exec(read("app/(platform)/remote-desktop/this-computer/page.tsx")), /cannot type until someone unlocks it at the computer/);
});
