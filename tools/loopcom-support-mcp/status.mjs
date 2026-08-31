/**
 * IS IT ACTUALLY RUNNING?  ->  node status.mjs
 *
 * ⛔ The failure this exists for: the watcher was off for three days and three
 * tickets went unseen, and nothing anywhere said so. "No new reports" looks
 * exactly like "a quiet week". This turns that into a sentence.
 *
 * Read-only. Touches no network except an optional token-expiry check, which is
 * decoded locally from the JWT and never prints the token itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToken } from "./watch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, f), "utf8"));
  } catch {
    return null;
  }
};

const beat = read(".watch-heartbeat.json");
const state = read(".watch-state.json");
const now = Date.now();
const mins = (ms) => Math.round(ms / 60000);

const lines = [];
let healthy = true;

// ── is it alive ───────────────────────────────────────────────────────────────
if (!beat) {
  healthy = false;
  lines.push("✗ NOT RUNNING — no heartbeat has ever been written.");
  lines.push("  Start it:  powershell -ExecutionPolicy Bypass -File install-task.ps1");
} else {
  const age = now - new Date(beat.at).getTime();
  // The poll is 60s, so two missed beats is the earliest honest alarm.
  if (age > 5 * 60_000) {
    healthy = false;
    lines.push(`✗ STALLED — last heartbeat ${mins(age)} min ago (pid ${beat.pid}, state "${beat.state}").`);
    lines.push("  Check logs\\watcher.log, then restart the task.");
  } else {
    lines.push(`✓ running — heartbeat ${Math.round(age / 1000)}s ago, ${beat.state}${beat.ticket ? ` on ${beat.ticket}` : ""}.`);
  }
  if (beat.state === "poll_failed") {
    healthy = false;
    lines.push(`  ⛔ last poll failed: ${beat.error}`);
  }
}

// ── what it has done ──────────────────────────────────────────────────────────
const claimed = Object.entries(state?.claimed ?? {});
const today = new Date().toISOString().slice(0, 10);
const worked = claimed.filter(([, c]) => c.status === "done" || c.status === "failed");
const todayRuns = claimed.filter(([, c]) => String(c.at).slice(0, 10) === today && (c.status === "done" || c.status === "failed" || c.status === "running"));
const failed = claimed.filter(([, c]) => c.status === "failed");
const running = claimed.filter(([, c]) => c.status === "running");

lines.push("");
lines.push(`  watching since   ${state?.startedAt ?? "—"}`);
lines.push(`  tickets worked   ${worked.length} all time · ${todayRuns.length} today`);
if (running.length) {
  for (const [ref, c] of running) {
    const age = now - new Date(c.at).getTime();
    lines.push(`  in flight        ${ref} (${mins(age)} min)${age > 30 * 60_000 ? "  ⛔ looks stuck — it will be retried once" : ""}`);
  }
}
if (failed.length) {
  healthy = false;
  lines.push(`  ⛔ failed        ${failed.map(([r]) => r).join(", ")}`);
}

// ── the token, which expires and takes the whole thing with it ────────────────
try {
  const tok = resolveToken();
  if (!tok) {
    healthy = false;
    lines.push("  ⛔ no LOOPCOM_TOKEN — it cannot read tickets at all.");
  } else {
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp) {
      const days = Math.floor((payload.exp * 1000 - now) / 86400000);
      const mark = days < 0 ? "⛔ EXPIRED" : days <= 7 ? "⛔" : "  ";
      lines.push(`  ${mark} token         ${days < 0 ? "expired " + -days + " days ago" : "expires in " + days + " days"} (${new Date(payload.exp * 1000).toISOString().slice(0, 10)})`);
      if (days <= 7) healthy = false;
    }
  }
} catch {
  lines.push("  token          could not be read — see the README to re-mint it.");
}

console.log("");
console.log("LoopCom support-ticket watcher");
console.log("──────────────────────────────");
console.log(lines.join("\n"));
console.log("");
process.exit(healthy ? 0 : 1);
