import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  buildChatDbSignedDownloadUrl,
  verifyChatDbSignedDownload,
  buildChatSignedDownloadUrl,
  verifyChatSignedDownload,
  buildChatAttachmentIdSignedDownloadUrl,
  verifyChatAttachmentIdSignedDownload,
  chatDbSignedPayload,
} from "./chatSignedUrl";

const BASE = "https://app.example.test";
const ATT = "cmqr9cs9402qqs013m7p64lpi";
const KEY = "tenant/thread/f_abc123.jpg";
const SIZE = 4096;

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k] as string;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

const REAL_KEY = { CHAT_URL_SIGNING_SECRET: "a-real-chat-signing-secret", JWT_SECRET: undefined };

function sigOf(url: string): string {
  return new URL(url).searchParams.get("sig") || new URL(url).searchParams.get("s") || "";
}
function expOf(url: string): string {
  return new URL(url).searchParams.get("exp") || new URL(url).searchParams.get("e") || "";
}

// ── §3a — the chat-db scheme must be a KEYED HMAC, not a bare hash ───────────

test("chat-db signature is NOT an unkeyed sha256 of the payload", () => {
  withEnv(REAL_KEY, () => {
    const url = buildChatDbSignedDownloadUrl(BASE, ATT, KEY, SIZE, 3600);
    const exp = Number(expOf(url));
    const unkeyed = crypto.createHash("sha256").update(chatDbSignedPayload(ATT, KEY, SIZE, exp)).digest("hex");
    assert.notEqual(sigOf(url), unkeyed, "an unkeyed digest here is a forgeable URL — must be createHmac");
  });
});

test("chat-db signature depends on the secret", () => {
  let a = "";
  let b = "";
  withEnv({ CHAT_URL_SIGNING_SECRET: "secret-one", JWT_SECRET: undefined }, () => {
    a = sigOf(buildChatDbSignedDownloadUrl(BASE, ATT, KEY, SIZE, 3600));
  });
  withEnv({ CHAT_URL_SIGNING_SECRET: "secret-two", JWT_SECRET: undefined }, () => {
    b = sigOf(buildChatDbSignedDownloadUrl(BASE, ATT, KEY, SIZE, 3600));
  });
  assert.notEqual(a, b, "changing the key must change the signature");
});

test("chat-db round-trips with the same key", () => {
  withEnv(REAL_KEY, () => {
    const url = buildChatDbSignedDownloadUrl(BASE, ATT, KEY, SIZE, 3600);
    assert.deepEqual(verifyChatDbSignedDownload(ATT, KEY, SIZE, expOf(url), sigOf(url)), { ok: true });
  });
});

test("a chat-db URL forged with the unkeyed scheme is REJECTED", () => {
  withEnv(REAL_KEY, () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const forged = crypto.createHash("sha256").update(chatDbSignedPayload(ATT, KEY, SIZE, exp)).digest("hex");
    const res = verifyChatDbSignedDownload(ATT, KEY, SIZE, String(exp), forged);
    assert.equal(res.ok, false);
  });
});

test("chat-db signature is bound to id, key and size", () => {
  withEnv(REAL_KEY, () => {
    const url = buildChatDbSignedDownloadUrl(BASE, ATT, KEY, SIZE, 3600);
    const e = expOf(url);
    const s = sigOf(url);
    assert.equal(verifyChatDbSignedDownload("other-id", KEY, SIZE, e, s).ok, false);
    assert.equal(verifyChatDbSignedDownload(ATT, "other/key", SIZE, e, s).ok, false);
    assert.equal(verifyChatDbSignedDownload(ATT, KEY, SIZE + 1, e, s).ok, false);
  });
});

test("an expired chat-db URL is rejected as expired", () => {
  withEnv(REAL_KEY, () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const res = verifyChatDbSignedDownload(ATT, KEY, SIZE, String(past), "0".repeat(64));
    assert.deepEqual(res, { ok: false, reason: "expired" });
  });
});

// ── §3b — the key must never be a constant published in this repo ────────────

test("the literal dev-signing-secret is never used as the key", () => {
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, CDR_INGEST_SECRET: undefined, JWT_SECRET: "j".repeat(64) }, () => {
    const url = buildChatSignedDownloadUrl(BASE, KEY, 900);
    const exp = Number(expOf(url));
    const withLiteral = crypto.createHmac("sha256", "dev-signing-secret").update(`chat:${KEY}:${exp}`).digest("hex");
    assert.notEqual(sigOf(url), withLiteral, "signing with a repo constant authorizes nothing");
  });
});

test("a URL signed with the old literal constant no longer verifies", () => {
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, CDR_INGEST_SECRET: undefined, JWT_SECRET: "j".repeat(64) }, () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const forged = crypto.createHmac("sha256", "dev-signing-secret").update(`chat:${KEY}:${exp}`).digest("hex");
    assert.equal(verifyChatSignedDownload(KEY, String(exp), forged).ok, false);
  });
});

test("a blank env var does not fall through to a constant — it derives from JWT_SECRET", () => {
  // "" is falsy, so the old `||` chain slid past blanks silently. Blank must be
  // treated as absent AND must not reach a literal.
  let derived = "";
  withEnv({ CHAT_URL_SIGNING_SECRET: "", MOH_URL_SIGNING_SECRET: "", CDR_INGEST_SECRET: "", JWT_SECRET: "j".repeat(64) }, () => {
    derived = sigOf(buildChatSignedDownloadUrl(BASE, KEY, 900));
  });
  let jwtOnly = "";
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, CDR_INGEST_SECRET: undefined, JWT_SECRET: "j".repeat(64) }, () => {
    jwtOnly = sigOf(buildChatSignedDownloadUrl(BASE, KEY, 900));
  });
  assert.equal(derived, jwtOnly, "a blank value must behave exactly like an absent one");
});

test("MOH_URL_SIGNING_SECRET no longer feeds the chat key (it differed between api and worker)", () => {
  // app-api-1 had it EMPTY while app-worker-1 had a 43-char value, so honouring
  // it here made the two processes disagree and silently 401 each other's links.
  let withMoh = "";
  let withoutMoh = "";
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: "a-different-moh-secret", JWT_SECRET: "j".repeat(64) }, () => {
    withMoh = sigOf(buildChatSignedDownloadUrl(BASE, KEY, 900));
  });
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, JWT_SECRET: "j".repeat(64) }, () => {
    withoutMoh = sigOf(buildChatSignedDownloadUrl(BASE, KEY, 900));
  });
  assert.equal(withMoh, withoutMoh, "the chat key must not vary with MOH_URL_SIGNING_SECRET");
});

test("two processes sharing only JWT_SECRET derive the same key", () => {
  // This is what makes api and worker agree with no new configuration.
  let api = "";
  let worker = "";
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, JWT_SECRET: "shared-jwt" }, () => {
    api = sigOf(buildChatAttachmentIdSignedDownloadUrl(BASE, ATT, 86400));
  });
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: "worker-only-moh-value", JWT_SECRET: "shared-jwt" }, () => {
    worker = sigOf(buildChatAttachmentIdSignedDownloadUrl(BASE, ATT, 86400));
  });
  assert.equal(api, worker);
});

test("the derived key is not the raw JWT_SECRET", () => {
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, JWT_SECRET: "raw-jwt-secret" }, () => {
    const url = buildChatSignedDownloadUrl(BASE, KEY, 900);
    const exp = Number(expOf(url));
    const raw = crypto.createHmac("sha256", "raw-jwt-secret").update(`chat:${KEY}:${exp}`).digest("hex");
    assert.notEqual(sigOf(url), raw, "use a derived key so a chat URL can never expose the JWT signing key");
  });
});

test("refuses to sign at all when nothing is configured", () => {
  withEnv({ CHAT_URL_SIGNING_SECRET: undefined, MOH_URL_SIGNING_SECRET: undefined, CDR_INGEST_SECRET: undefined, JWT_SECRET: undefined }, () => {
    assert.throws(() => buildChatSignedDownloadUrl(BASE, KEY, 900), /chat_url_signing_secret_unavailable/);
  });
});

// ── The other two schemes keep working ──────────────────────────────────────

test("storageKey scheme round-trips", () => {
  withEnv(REAL_KEY, () => {
    const url = buildChatSignedDownloadUrl(BASE, KEY, 900);
    assert.deepEqual(verifyChatSignedDownload(KEY, expOf(url), sigOf(url)), { ok: true });
  });
});

test("attachment-id scheme round-trips", () => {
  withEnv(REAL_KEY, () => {
    const url = buildChatAttachmentIdSignedDownloadUrl(BASE, ATT, 86400, "voice note.m4a");
    assert.deepEqual(verifyChatAttachmentIdSignedDownload(ATT, expOf(url), sigOf(url)), { ok: true });
  });
});

test("the three schemes do not accept each other's signatures", () => {
  withEnv(REAL_KEY, () => {
    const dbUrl = buildChatDbSignedDownloadUrl(BASE, ATT, KEY, SIZE, 3600);
    assert.equal(verifyChatSignedDownload(KEY, expOf(dbUrl), sigOf(dbUrl)).ok, false);
    const keyUrl = buildChatSignedDownloadUrl(BASE, KEY, 3600);
    assert.equal(verifyChatDbSignedDownload(ATT, KEY, SIZE, expOf(keyUrl), sigOf(keyUrl)).ok, false);
  });
});

// ── Guard the source itself ─────────────────────────────────────────────────

const source = fs.readFileSync(path.join(__dirname, "chatSignedUrl.ts"), "utf8");

test("no createHash anywhere in the module", () => {
  assert.ok(!source.includes("createHash("), "every signature in this file must be a keyed createHmac");
});

test("the dev-signing-secret literal is gone from the resolver", () => {
  const fn = source.slice(source.indexOf("function signingSecret"), source.indexOf("export function chatSignedPayload"));
  assert.ok(!fn.includes('"dev-signing-secret"'), "the resolver must never fall back to a repo constant");
});
