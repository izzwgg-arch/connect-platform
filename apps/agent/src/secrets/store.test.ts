import { test } from "node:test";
import assert from "node:assert/strict";
import { SecretStore, type Crypto } from "./store";
import { AuditLog } from "../audit/audit";

const audit = new AuditLog([{ async write() {} }]);

// Trivial reversible "crypto" for tests (not real encryption).
const fakeCrypto: Crypto = {
  encryptJson: (v) => "enc:" + JSON.stringify(v),
  decryptJson: (s) => JSON.parse(String(s).replace(/^enc:/, "")),
  hasMasterKey: () => true,
};

function fakePrisma() {
  const rows = new Map<string, any>();
  return {
    rows,
    agentSecret: {
      findUnique: async ({ where }: any) => rows.get(where.key) ?? null,
      upsert: async ({ where, create, update }: any) => { const r = { key: where.key, ...(rows.get(where.key) || create), ...update }; rows.set(where.key, r); return r; },
      deleteMany: async ({ where }: any) => { rows.delete(where.key); return { count: 1 }; },
    },
  };
}

test("set encrypts + get decrypts; value round-trips", async () => {
  const prisma = fakePrisma();
  const s = new SecretStore(prisma as any, fakeCrypto, audit);
  await s.set("anthropic_api_key", "sk-ant-REAL", "izzy");
  assert.match(prisma.rows.get("anthropic_api_key").valueEnc, /^enc:/); // stored encrypted, not plaintext
  assert.equal(await s.get("anthropic_api_key"), "sk-ant-REAL");
});

test("empty value clears the key", async () => {
  const prisma = fakePrisma();
  const s = new SecretStore(prisma as any, fakeCrypto, audit);
  await s.set("openai_api_key", "sk-x", "izzy");
  await s.set("openai_api_key", "  ", "izzy");
  assert.equal(await s.get("openai_api_key"), null);
});

test("env fallback used when no stored value (placeholder text ignored)", async () => {
  const prisma = fakePrisma();
  const s = new SecretStore(prisma as any, fakeCrypto, audit);
  process.env.OPENAI_API_KEY = "sk-from-env";
  assert.equal(await s.get("openai_api_key"), "sk-from-env");
  s.invalidate();
  process.env.OPENAI_API_KEY = "(paste your real OpenAI key)"; // placeholder → ignored
  assert.equal(await s.get("openai_api_key"), null);
  delete process.env.OPENAI_API_KEY;
});

test("status is masked (last 4 only), never the full value", async () => {
  const prisma = fakePrisma();
  const s = new SecretStore(prisma as any, fakeCrypto, audit);
  await s.set("yiddishlabs_api_key", "yl_live_abcd1234WXYZ", "izzy");
  const st = await s.status();
  assert.equal(st.yiddishlabs_api_key.configured, true);
  assert.equal(st.yiddishlabs_api_key.source, "store");
  assert.equal(st.yiddishlabs_api_key.hint, "…WXYZ");
  assert.ok(!JSON.stringify(st).includes("yl_live_abcd1234")); // full value never exposed
});

test("without master key, set throws (fail-closed)", async () => {
  const prisma = fakePrisma();
  const noKey: Crypto = { ...fakeCrypto, hasMasterKey: () => false };
  const s = new SecretStore(prisma as any, noKey, audit);
  await assert.rejects(() => s.set("anthropic_api_key", "x", "izzy"), /master_key_missing/);
});
