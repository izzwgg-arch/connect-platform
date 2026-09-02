import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampFraction,
  inputInjectionSupported,
  sanitizeCommand,
  helperScriptPath,
  NAMED_KEYS,
  PowerShellInputInjector,
  type SpawnLike,
} from "./inputInjector";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `sanitizeCommand` is a trust boundary, not a formality: it is the last thing
 * between a message that arrived over the network from the support side and
 * Windows' own input queue. Anything it lets through gets performed on a real
 * person's computer.
 */

test("⛔ a pointer position can never land outside the screen", () => {
  // A bad fraction is a mouse warped to a corner of somebody's real desktop.
  assert.equal(clampFraction(-1), 0);
  assert.equal(clampFraction(0), 0);
  assert.equal(clampFraction(0.5), 0.5);
  assert.equal(clampFraction(1), 1);
  assert.equal(clampFraction(42), 1);
});

test("⛔ a malformed coordinate is refused, NOT clamped to a corner", () => {
  // Turning NaN into "click the top-left corner" is how a support tool clicks
  // something nobody asked it to. Malformed means refuse the whole command.
  assert.equal(clampFraction(Number.NaN), null);
  assert.equal(clampFraction(Number.POSITIVE_INFINITY), null);
  assert.equal(clampFraction(Number.NEGATIVE_INFINITY), null);

  for (const bad of [{ x: Number.NaN, y: 0.5 }, { x: 0.5, y: Number.NaN }, {}]) {
    assert.equal(
      sanitizeCommand({ kind: "click", ...bad }),
      null,
      `${JSON.stringify(bad)} should refuse the whole click`,
    );
  }
  assert.equal(sanitizeCommand({ kind: "move", x: "left", y: "up" }), null);
});

test("out-of-range coordinates ARE clamped — a drag past the window edge is normal", () => {
  // Refusing these would freeze the pointer mid-session; clamping keeps it
  // usable. This is the case that must NOT be confused with malformed input.
  const cmd = sanitizeCommand({ kind: "move", x: 5, y: -2 });
  assert.deepEqual(cmd, { kind: "move", x: 1, y: 0 });
});

test("text and key commands do not need coordinates", () => {
  // Only pointer commands are gated on x/y; typing has no position.
  assert.deepEqual(sanitizeCommand({ kind: "text", text: "hello" }), { kind: "text", text: "hello" });
  assert.deepEqual(sanitizeCommand({ kind: "key", key: "enter" }), {
    kind: "key", key: "enter", modifiers: [],
  });
});

test("rubbish is refused outright", () => {
  for (const bad of [null, undefined, 42, "move", [], {}, { kind: "shutdown" }, { kind: "" }]) {
    assert.equal(sanitizeCommand(bad as any), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test("⛔ an unknown command kind is never passed through", () => {
  // The helper switches on `kind`; an unrecognised one must die here rather
  // than reach a future branch that does something unintended.
  assert.equal(sanitizeCommand({ kind: "exec", text: "format c:" }), null);
  assert.equal(sanitizeCommand({ kind: "__proto__" }), null);
});

test("mouse buttons fall back to left, never to something invented", () => {
  assert.equal((sanitizeCommand({ kind: "click", x: 0.1, y: 0.1, button: "right" }) as any).button, "right");
  assert.equal((sanitizeCommand({ kind: "click", x: 0.1, y: 0.1, button: "middle" }) as any).button, "middle");
  assert.equal((sanitizeCommand({ kind: "click", x: 0.1, y: 0.1, button: "nonsense" }) as any).button, "left");
  assert.equal((sanitizeCommand({ kind: "click", x: 0.1, y: 0.1 }) as any).button, "left");
});

test("a double click is only double when explicitly asked for", () => {
  assert.equal((sanitizeCommand({ kind: "click", x: 0, y: 0, double: true }) as any).double, true);
  assert.equal((sanitizeCommand({ kind: "click", x: 0, y: 0, double: "yes" }) as any).double, false);
  assert.equal((sanitizeCommand({ kind: "click", x: 0, y: 0 }) as any).double, false);
});

test("⛔ scroll is bounded so a runaway wheel cannot scroll forever", () => {
  assert.equal((sanitizeCommand({ kind: "scroll", x: 0, y: 0, deltaY: 999999 }) as any).deltaY, 2400);
  assert.equal((sanitizeCommand({ kind: "scroll", x: 0, y: 0, deltaY: -999999 }) as any).deltaY, -2400);
  assert.equal((sanitizeCommand({ kind: "scroll", x: 0, y: 0, deltaY: 120 }) as any).deltaY, 120);
});

test("a zero or non-numeric scroll is dropped rather than sent", () => {
  assert.equal(sanitizeCommand({ kind: "scroll", x: 0, y: 0, deltaY: 0 }), null);
  assert.equal(sanitizeCommand({ kind: "scroll", x: 0, y: 0, deltaY: "down" }), null);
  assert.equal(sanitizeCommand({ kind: "scroll", x: 0, y: 0 }), null);
});

test("⛔ typed text is capped, so one message cannot type an essay", () => {
  const long = "a".repeat(5000);
  const cmd = sanitizeCommand({ kind: "text", text: long }) as any;
  assert.equal(cmd.text.length, 500);
});

test("newlines are stripped from typed text", () => {
  // They would be typed as literal characters and do nothing useful; pressing
  // Enter is a separate, explicit command.
  const cmd = sanitizeCommand({ kind: "text", text: "line one\r\nline two" }) as any;
  assert.equal(cmd.text, "line oneline two");
});

test("empty text is dropped", () => {
  assert.equal(sanitizeCommand({ kind: "text", text: "" }), null);
  assert.equal(sanitizeCommand({ kind: "text", text: "\r\n" }), null);
  assert.equal(sanitizeCommand({ kind: "text", text: 123 }), null);
});

test("named keys are accepted and normalised to lowercase", () => {
  const cmd = sanitizeCommand({ kind: "key", key: "ENTER" }) as any;
  assert.equal(cmd.key, "enter");
  assert.ok(NAMED_KEYS.has("enter"));
  assert.ok(NAMED_KEYS.has("f12"));
});

test("a single character is accepted as a key; a multi-character unknown is not", () => {
  assert.equal((sanitizeCommand({ kind: "key", key: "a" }) as any).key, "a");
  // Anything that is neither a known key name nor one character is refused.
  assert.equal(sanitizeCommand({ kind: "key", key: "runprogram" }), null);
  assert.equal(sanitizeCommand({ kind: "key", key: "" }), null);
});

test("⛔ only the four real modifiers survive", () => {
  const cmd = sanitizeCommand({
    kind: "key",
    key: "a",
    modifiers: ["ctrl", "SHIFT", "hyper", "sudo", "alt", "meta", 7],
  }) as any;
  assert.deepEqual(cmd.modifiers, ["ctrl", "shift", "alt", "meta"]);
});

test("a non-array modifiers field does not crash or leak through", () => {
  const cmd = sanitizeCommand({ kind: "key", key: "a", modifiers: "ctrl" }) as any;
  assert.deepEqual(cmd.modifiers, []);
});

test("input injection is Windows-only by construction", () => {
  // The helper is PowerShell and P/Invoke. Claiming support elsewhere would
  // mean a support person clicking into a void with no error.
  assert.equal(inputInjectionSupported("win32"), true);
  assert.equal(inputInjectionSupported("darwin"), false);
  assert.equal(inputInjectionSupported("linux"), false);
});

test("the helper script lives under the app's own data directory", () => {
  const p = helperScriptPath("C:\\Users\\someone\\AppData\\Roaming\\Connect");
  assert.ok(p.includes("remote-support"));
  assert.ok(p.endsWith("input-helper.ps1"));
});

/* ── the helper dying must never reach Electron's main process ───────── */

/**
 * A stand-in for the PowerShell child: EventEmitter stdio, no real process.
 * The real failure (2026-09-02, first live session) was an EPIPE delivered as
 * an "error" EVENT on stdin after a write to a helper that had already died —
 * nothing listened, so Node raised it as an uncaught exception in the main
 * process and Electron showed its crash dialog over the customer's screen.
 */
function fakeChild() {
  const child: any = new EventEmitter();
  const stdin: any = new EventEmitter();
  stdin.writable = true;
  stdin.destroyed = false;
  stdin.writes = [] as string[];
  stdin.write = (chunk: string, cb?: () => void) => { stdin.writes.push(chunk); cb?.(); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function injectorWithFake() {
  const child = fakeChild();
  const spawnImpl: SpawnLike = () => child;
  const injector = new PowerShellInputInjector(join(tmpdir(), "connect-injector-test", "helper.ps1"), spawnImpl);
  return { child, injector };
}

test("⛔ a broken pipe on the helper's stdin is caught, reported ONCE, and never thrown", () => {
  const { child, injector } = injectorWithFake();
  const reasons: string[] = [];
  assert.equal(injector.start((r: string) => reasons.push(r)), true);
  assert.equal(injector.available, true);

  injector.send({ kind: "move", x: 0.5, y: 0.5 });
  assert.equal(child.stdin.writes.length, 1);

  // The write "succeeded"; the EPIPE arrives afterwards, as an event.
  const epipe: any = new Error("write EPIPE");
  epipe.code = "EPIPE";
  // No listener would make this an uncaught exception; with one it must not throw.
  assert.doesNotThrow(() => child.stdin.emit("error", epipe));
  // The process then exits too — the owner must still hear about it exactly once.
  child.emit("exit", null, "SIGTERM");

  assert.deepEqual(reasons, ["helper_pipe_broken_EPIPE"]);
  assert.equal(injector.available, false);

  // After death every event is dropped, never written to a dead pipe.
  injector.send({ kind: "move", x: 0.6, y: 0.6 });
  assert.equal(child.stdin.writes.length, 1);
});

test("the helper's last stderr rides along with the exit reason", () => {
  const { child, injector } = injectorWithFake();
  const reasons: string[] = [];
  injector.start((r: string) => reasons.push(r));
  child.stderr.emit("data", "Access is denied by policy" + String.fromCharCode(10));
  child.emit("exit", 1, null);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^helper_exited_1: /);
  assert.match(reasons[0], /Access is denied by policy/);
});

test("a helper whose pipe closed on its own is not 'available', even though it was never killed", () => {
  const { child, injector } = injectorWithFake();
  injector.start(() => {});
  child.stdin.writable = false;
  assert.equal(child.killed, false);
  assert.equal(injector.available, false);
  injector.send({ kind: "move", x: 0.5, y: 0.5 });
  assert.equal(child.stdin.writes.length, 0);
});

test("stop() after the helper already died does not throw and reports nothing more", () => {
  const { child, injector } = injectorWithFake();
  const reasons: string[] = [];
  injector.start((r: string) => reasons.push(r));
  child.emit("exit", 0, null);
  assert.doesNotThrow(() => injector.stop());
  assert.doesNotThrow(() => injector.stop());
  assert.equal(reasons.length, 1);
});
