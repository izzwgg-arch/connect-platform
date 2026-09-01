#!/usr/bin/env node
/**
 * THE WATCHDOG — restarts the watcher when its heartbeat goes quiet.
 *
 * ⛔ WHY: `status.mjs` is an alarm nobody runs on a timer. On 2026-08-31 the
 * watcher died to a Ctrl+C and sat dead for 18 hours; the only thing that
 * noticed was an audit the next day. This runs from its own scheduled task
 * every 10 minutes ("Loopcom support watcher watchdog", install-task.ps1) and
 * SELF-HEALS; the server-side guardrail (supportLoopGuardrail.ts) is the alarm
 * of last resort when even this cannot bring it back.
 *
 * Decision, deliberately dumb:
 *   heartbeat fresh (< 10 min)      -> exit quietly (no log spam)
 *   stale or missing                -> log it, stop + start the watcher task
 *
 * ⛔ 10 minutes, because the watcher beats every ~60s INCLUDING during runs
 * (watch.mjs beats inside onStep). A 10-minute silence is a dead or wedged
 * process, never a long investigation — restarting sooner could kill a healthy
 * agent run mid-flight.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_FILE = path.join(HERE, ".watch-heartbeat.json");
const LOG = path.join(HERE, "logs", "watchdog.log");
const TASK_NAME = "Loopcom support ticket watcher";
export const STALE_MS = Number(process.env.WATCHDOG_STALE_MS || 10 * 60 * 1000);

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* a watchdog that can crash on its own log is a liability */
  }
}

export function heartbeatAgeMs(now = Date.now()) {
  try {
    const beat = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8"));
    const at = new Date(beat.at ?? 0).getTime();
    return Number.isFinite(at) && at > 0 ? now - at : null;
  } catch {
    return null; // never beaten (or unreadable) — both mean "not provably alive"
  }
}

function ps(args) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

function main() {
  const age = heartbeatAgeMs();
  if (age != null && age < STALE_MS) return; // healthy — say nothing

  const ageText = age == null ? "no heartbeat file" : `${Math.round(age / 60000)} min stale`;
  log(`heartbeat ${ageText} — restarting "${TASK_NAME}"`);
  try {
    // Stop first: a WEDGED process still counts as Running, and Start on a
    // running task is a no-op (MultipleInstances IgnoreNew). Stopping a task
    // that is not running is harmless.
    try {
      ps(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);
    } catch {
      /* fine — it probably was not running */
    }
    ps(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
    log("restart issued");
  } catch (err) {
    // The server-side guardrail alarms on the stale heartbeat regardless —
    // this log line is for the person who comes to look afterwards.
    log(`restart FAILED: ${String(err?.message ?? err).slice(0, 200)}`);
  }
}

// Importable for tests; only a direct run acts.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
