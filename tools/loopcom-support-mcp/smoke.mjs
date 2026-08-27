/**
 * Drives the REAL server over stdio — initialize, tools/list, then a call with
 * no token, which must come back as plain English rather than a stack trace.
 * Proof that it starts and speaks MCP; it deliberately contacts no network.
 *   node smoke.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "server.mjs")], {
  cwd: here,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LOOPCOM_TOKEN: "" },
});

const seen = [];
let buf = "";
let stderr = "";
child.on("error", (e) => { stderr += `spawn error: ${e.message}\n`; });
child.stderr.on("data", (d) => { stderr += d.toString(); });
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { try { seen.push(JSON.parse(line)); } catch { /* not a frame */ } }
  }
});

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const waitFor = (id, ms = 5000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const hit = seen.find((m) => m.id === id);
      if (hit) { clearInterval(tick); resolve(hit); }
      else if (Date.now() - started > ms) { clearInterval(tick); reject(new Error(`no reply to id ${id}. stderr: ${stderr.slice(0, 400)}`)); }
    }, 25);
  });

let failures = 0;
const check = (label, pass, detail) => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  const init = await waitFor(1);
  check("initialize", init?.result?.serverInfo?.name === "loopcom-support", init?.result?.serverInfo?.name);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = await waitFor(2);
  const names = (tools?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ["get_conversation", "get_customer", "get_support_ticket", "list_support_tickets"];
  check("tools/list", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));

  // ⛔ The property that matters most: no write tool exists. v1 is read-only,
  // and a customer-messaging tool must never appear here by accident.
  const writeish = names.filter((n) => /reply|send|message|approve|apply|fix|update|set_/.test(n));
  check("read-only (no write tools)", writeish.length === 0, writeish.join(", ") || "none");

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_support_tickets", arguments: {} } });
  const call = await waitFor(3);
  const text = call?.result?.content?.[0]?.text ?? "";
  check("missing token is an error, not a crash", call?.result?.isError === true);
  check("missing token explains itself", /LOOPCOM_TOKEN/.test(text), text.slice(0, 80));
} catch (err) {
  check("handshake", false, String(err.message));
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
