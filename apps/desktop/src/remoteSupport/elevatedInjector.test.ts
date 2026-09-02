/**
 * Administrator access (2026-09-02): the elevated input helper, rehearsed with
 * a fake launcher and a fake named pipe. Nothing here touches Windows, UAC or
 * PowerShell; what is proven is the app's side of the contract:
 *
 *  - the grant can only be reported once the pipe is open AND the helper has
 *    accepted the one-time token ("ok elevated") — a declined UAC prompt, a
 *    launcher that dies, or a helper that answers anything else all resolve
 *    FALSE, never throw, and never leave a live `available` behind;
 *  - the token is the FIRST thing written on the pipe, before any command;
 *  - `stop()` asks the helper to exit over the pipe (the app cannot kill an
 *    elevated process) and ends the socket;
 *  - a pipe that breaks mid-session is reported once and never thrown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElevatedInputInjector, type SpawnLike, type ConnectLike } from "./inputInjector";

function fakeLauncher() {
  const child: any = new EventEmitter();
  for (const k of ["stdin", "stdout", "stderr"]) child[k] = new EventEmitter();
  child.stdin.writable = true;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

/** A fake pipe: records writes, lets the test script the helper's replies. */
function fakePipe() {
  const sock: any = new EventEmitter();
  sock.writes = [] as string[];
  sock.destroyed = false;
  sock.writable = true;
  sock.encoding = null;
  sock.setEncoding = (e: string) => { sock.encoding = e; };
  sock.write = (chunk: string, cb?: () => void) => { sock.writes.push(chunk); cb?.(); return true; };
  sock.end = () => { sock.writable = false; };
  sock.destroy = () => { sock.destroyed = true; sock.writable = false; };
  return sock;
}

function harness(opts: { helperReply?: string; connectFails?: boolean } = {}) {
  const launcher = fakeLauncher();
  const spawnImpl: SpawnLike = () => launcher;
  const pipes: any[] = [];
  const connectImpl: ConnectLike = (path: string) => {
    const s = fakePipe();
    s.path = path;
    pipes.push(s);
    // Async, like a real socket: connect (or fail), then the helper's greeting.
    setImmediate(() => {
      if (opts.connectFails) { s.emit("error", new Error("ENOENT")); return; }
      s.emit("connect");
      setImmediate(() => s.emit("data", `${opts.helperReply ?? "ok elevated"}\n`));
    });
    return s;
  };
  const injector = new ElevatedInputInjector(
    join(tmpdir(), "connect-elevated-test", "helper.ps1"),
    spawnImpl,
    connectImpl,
    { token: "tok-123", pipeName: "loopcom-rs-test" },
  );
  return { launcher, pipes, injector };
}

test("the grant is available only after the pipe answered 'ok elevated' — and the token went first", async () => {
  const { launcher, pipes, injector } = harness();
  const reasons: string[] = [];
  const ok = await injector.start((r: string) => reasons.push(r), 5_000);
  assert.equal(ok, true);
  assert.equal(injector.available, true);
  assert.equal(pipes.length, 1);
  assert.equal(pipes[0].path, "\\\\.\\pipe\\loopcom-rs-test");
  assert.equal(pipes[0].writes[0], "tok-123\n", "the one-time token must be the first line on the pipe");
  injector.send({ kind: "move", x: 0.25, y: 0.75 });
  assert.equal(pipes[0].writes.length, 2);
  assert.match(pipes[0].writes[1], /"kind":"move"/);
  assert.equal(launcher.killed, false);
  assert.deepEqual(reasons, []);
});

test("⛔ a declined UAC prompt (launcher exits first) resolves false and never becomes 'available'", async () => {
  const { launcher, injector } = harness({ connectFails: true });
  const reasons: string[] = [];
  const started = injector.start((r: string) => reasons.push(r), 5_000);
  // Start-Process -Verb RunAs throws on "No"; the launcher exits non-zero.
  setImmediate(() => launcher.emit("exit", 1, null));
  const ok = await started;
  assert.equal(ok, false);
  assert.equal(injector.available, false);
  assert.deepEqual(reasons, ["elevated_helper_exited_1"]);
  // After a refusal, sending is a silent no-op — nothing to send to.
  injector.send({ kind: "move", x: 0.5, y: 0.5 });
});

test("⛔ a helper that refuses the token is not trusted", async () => {
  const { injector } = harness({ helperReply: "err bad token" });
  const ok = await injector.start(undefined, 1_500);
  assert.equal(ok, false);
  assert.equal(injector.available, false);
});

test("nothing answering the pipe within the wait resolves false, once, without throwing", async () => {
  const { injector } = harness({ connectFails: true });
  const reasons: string[] = [];
  const ok = await injector.start((r: string) => reasons.push(r), 1_200);
  assert.equal(ok, false);
  assert.deepEqual(reasons, ["elevated_helper_timeout"]);
});

test("stop() asks the helper to exit over the pipe and ends the socket — the app cannot kill an elevated process", async () => {
  const { launcher, pipes, injector } = harness();
  await injector.start(undefined, 5_000);
  injector.stop();
  const last = pipes[0].writes[pipes[0].writes.length - 1];
  assert.equal(last, '{"kind":"stop"}\n');
  assert.equal(pipes[0].writable, false);
  assert.equal(injector.available, false);
  assert.equal(launcher.killed, true, "the (non-elevated) launcher is ours to kill");
});

test("⛔ a pipe that breaks mid-session is reported once, never thrown, and stops further sends", async () => {
  const { pipes, injector } = harness();
  const reasons: string[] = [];
  await injector.start((r: string) => reasons.push(r), 5_000);
  const epipe: any = new Error("write EPIPE");
  epipe.code = "EPIPE";
  assert.doesNotThrow(() => pipes[0].emit("error", epipe));
  pipes[0].emit("close");
  assert.deepEqual(reasons, ["elevated_pipe_broken"]);
  assert.equal(injector.available, false);
  const before = pipes[0].writes.length;
  injector.send({ kind: "move", x: 0.5, y: 0.5 });
  assert.equal(pipes[0].writes.length, before);
});
