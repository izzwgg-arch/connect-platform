// Local end-to-end harness for the smart-home IVR (no PBX needed).
// Boots the real module (FastAGI server + IVR + config), points it at a mock
// Home Assistant, then acts as Asterisk over TCP: sends AGI headers, answers
// commands, "presses" the PIN and a menu digit, and verifies HA was called.
//
// Run: tsx src/smarthome/e2eLocal.ts

import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createSmartHomeModule } from "./index";
import { hashPin } from "./pinHash";

const PIN = "4821";

async function main() {
  // 1) Mock Home Assistant
  const haCalls: string[] = [];
  const haServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      haCalls.push(`${req.method} ${req.url} auth=${req.headers.authorization}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
  });
  await new Promise<void>((r) => haServer.listen(0, "127.0.0.1", r));
  const haPort = (haServer.address() as AddressInfo).port;

  // 2) Real config file
  const dir = mkdtempSync(join(tmpdir(), "smarthome-e2e-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      accounts: [
        {
          id: "e2e-home",
          pinHash: hashPin(PIN),
          ha: { baseUrl: `http://127.0.0.1:${haPort}`, token: "e2e-token" },
          menu: [
            { digit: "1", label: "lights on", domain: "light", service: "turn_on", entityId: "light.living" },
            { digit: "2", label: "lights off", domain: "light", service: "turn_off", entityId: "light.living" },
          ],
        },
      ],
    }),
  );

  // 3) Real smart-home module
  const agiPort = 45730;
  const mod = createSmartHomeModule({
    configPath,
    agiPort,
    agiBind: "127.0.0.1",
    allowedPeers: ["127.0.0.1"],
    haTimeoutMs: 3000,
  });
  await mod.start();

  // 4) Fake Asterisk: connect, send headers, script responses
  const transcript: string[] = [];
  const played: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect(agiPort, "127.0.0.1", () => {
      sock.write(
        [
          "agi_network: yes",
          "agi_request: agi://127.0.0.1",
          "agi_channel: PJSIP/test-000001",
          "agi_callerid: 15551234567",
          "agi_dnid: 8005551000",
          "",
          "",
        ].join("\n"),
      );
    });
    sock.setEncoding("utf8");
    const inputs = [PIN, "1", "*"]; // PIN, lights on, hang up politely
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const cmd = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!cmd) continue;
        transcript.push(cmd);
        if (cmd.startsWith("ANSWER")) {
          sock.write("200 result=0\n");
        } else if (cmd.startsWith("GET DATA")) {
          const digits = inputs.length ? inputs.shift()! : "";
          if (digits === "") sock.write("200 result= (timeout)\n");
          else sock.write(`200 result=${digits}\n`);
        } else if (cmd.startsWith("STREAM FILE")) {
          played.push(cmd.split(/\s+/)[2] ?? "");
          sock.write("200 result=0\n");
        } else if (cmd.startsWith("HANGUP")) {
          sock.write("200 result=1\n");
          sock.end();
        } else {
          sock.write("200 result=0\n");
        }
      }
    });
    sock.on("close", () => resolve());
    sock.on("error", reject);
    setTimeout(() => reject(new Error("e2e timed out")), 15_000).unref();
  });

  mod.stop();
  haServer.close();

  // 5) Assertions
  const fail = (msg: string) => {
    console.error(`E2E FAIL: ${msg}`);
    console.error({ transcript, played, haCalls });
    process.exit(1);
  };
  if (!transcript.some((c) => c.startsWith("ANSWER"))) fail("call was never answered");
  if (haCalls.length !== 1 || !haCalls[0].includes("POST /api/services/light/turn_on"))
    fail(`expected one HA turn_on call, got: ${JSON.stringify(haCalls)}`);
  if (!haCalls[0].includes("Bearer e2e-token")) fail("HA token not sent");
  if (!played.includes("auth-thankyou")) fail("confirmation prompt not played");
  if (!played.includes("vm-goodbye")) fail("goodbye prompt not played");

  console.log("E2E PASS");
  console.log("AGI transcript:", transcript);
  console.log("Prompts played:", played);
  console.log("HA calls:", haCalls);
}

main().catch((err) => {
  console.error("E2E error:", err);
  process.exit(1);
});
