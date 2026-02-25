#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.BASE_URL || "https://app.connectcomunications.com/api";
const PASSWORD = process.env.PASSWORD || "Passw0rd!234";
const now = Date.now();
const EMAIL = `support${now}@connectcomunications.com`;
const TENANT_NAME = `PBX Smoke ${now}`;
const DID_E164 = `+13055${String(now % 100000).padStart(5, "0")}`;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const INFRA_ENV_PATH = "/opt/connectcomms/infra/.env";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function shInherit(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

async function req(method, path, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

function requireStatus(resp, expected, label) {
  const ok = Array.isArray(expected) ? expected.includes(resp.status) : resp.status === expected;
  if (!ok) {
    throw new Error(`${label} failed (${resp.status}): ${resp.text}`);
  }
}

function readInfraEnv() {
  const raw = readFileSync(INFRA_ENV_PATH, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

async function main() {
  console.log("[v1.1.0] starting PBX smoke with PBX_SIMULATE=true");
  console.log(`[info] BASE_URL=${BASE_URL}`);
  console.log(`[info] REPO_ROOT=${REPO_ROOT}`);

  shInherit(`cd ${JSON.stringify(REPO_ROOT)} && PBX_SIMULATE=true docker compose -f docker-compose.app.yml up -d api worker >/dev/null`);

  let healthy = false;
  for (let i = 0; i < 40; i += 1) {
    const h = await req("GET", "/health", "", null);
    if (h.status === 200) { healthy = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!healthy) throw new Error("api health did not become ready");

  let r = await req("POST", "/auth/signup", "", { tenantName: TENANT_NAME, email: EMAIL, password: PASSWORD });
  requireStatus(r, 200, "signup");

  const infra = readInfraEnv();
  const pgUser = infra.POSTGRES_USER;
  const pgDb = infra.POSTGRES_DB;
  const pgContainer = sh("docker ps --format '{{.Names}}' | grep -m1 postgres");

  sh(`docker exec -i ${pgContainer} psql -U ${pgUser} -d ${pgDb} -c \"UPDATE \\\"User\\\" SET role='SUPER_ADMIN' WHERE email='${EMAIL}';\" >/dev/null`);

  r = await req("POST", "/auth/login", "", { email: EMAIL, password: PASSWORD });
  requireStatus(r, 200, "login");
  const token = r.json?.token;
  if (!token) throw new Error(`no token from login: ${r.text}`);

  r = await req("POST", "/admin/pbx/instances", token, {
    name: "Smoke PBX",
    baseUrl: "https://pbx.sim.local",
    token: "sim-token-1234",
    secret: "sim-secret-1234",
    isEnabled: true
  });
  requireStatus(r, 200, "create pbx instance");
  const instanceId = r.json?.id;
  if (!instanceId) throw new Error(`missing instance id: ${r.text}`);
  console.log("[ok] PBX instance created");

  r = await req("POST", "/pbx/link", token, { pbxInstanceId: instanceId, pbxTenantId: "tenant-sim-1", pbxDomain: "pbx.sim.local" });
  requireStatus(r, 200, "pbx link");
  if (r.json?.status !== "LINKED") throw new Error(`pbx link response unexpected: ${r.text}`);
  console.log("[ok] Tenant linked to PBX");

  const me = await req("GET", "/me", token, null);
  requireStatus(me, 200, "me");
  const tenantId = String(me.json?.tenantId || "");
  if (!tenantId) throw new Error(`tenant lookup failed from /me: ${me.text}`);

  const seedSql = `INSERT INTO "PhoneNumber" (id, "tenantId", provider, "phoneNumber", "providerId", capabilities, status, "purchasedAt", "createdAt", "updatedAt") VALUES (concat('num_', substr(md5(random()::text),1,20)), '${tenantId}', 'TWILIO', '${DID_E164}', 'SIM_TW_1001', jsonb_build_object('sms', true, 'voice', true), 'ACTIVE', now(), now(), now()) RETURNING id;`;
  const numRaw = sh(`docker exec -i ${pgContainer} psql -U ${pgUser} -d ${pgDb} -t -A -c ${JSON.stringify(seedSql)}`);
  const numId = (numRaw.split(/\r?\n/).find((x) => x.startsWith("num_")) || "").trim();
  if (!numId) throw new Error(`number seed failed: ${numRaw}`);
  console.log(`[debug] seeded number ${numId} for tenant ${tenantId}`);
  r = await req("POST", "/pbx/extensions", token, { extensionNumber: "1001", displayName: "PBX User", enableWebrtc: true, enableMobile: true });
  requireStatus(r, [200, 202], "pbx extension create");
  if (r.status === 200) {
    if (!r.json?.pbxLink?.id || !r.json?.provisioning?.sipUsername || !r.json?.provisioning?.qrPayload) {
      throw new Error(`provisioning response missing fields: ${r.text}`);
    }
  }
  console.log("[ok] Extension provisioning endpoint reachable");

  r = await req("POST", "/pbx/dids/assign", token, { phoneNumberId: numId, routeType: "EXTENSION", routeTarget: "1001" });
  console.log(`[debug] /pbx/dids/assign status=${r.status}`);
  console.log(r.text);
  if (r.status === 404) throw new Error("/pbx/dids/assign returned 404");
  requireStatus(r, [200, 201, 202], "pbx did assign");
  console.log("[ok] DID assignment endpoint responded without 404");

  console.log("[info] waiting for CDR sync cycle (up to 150s)");
  let cdrOk = false;
  for (let i = 0; i < 30; i += 1) {
    const calls = await req("GET", "/voice/calls", token, null);
    if (calls.status === 200 && Array.isArray(calls.json) && calls.json.length > 0) {
      cdrOk = true;
      break;
    }
    await new Promise((r2) => setTimeout(r2, 5000));
  }
  if (!cdrOk) throw new Error("expected CDR sync records not found");
  console.log("[ok] CDR sync inserted call records");

  const st = await req("GET", "/pbx/status", token, null);
  requireStatus(st, 200, "pbx status");
  if (!st.json?.linked) throw new Error(`pbx status not linked: ${st.text}`);

  console.log("[v1.1.0] smoke complete");
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
