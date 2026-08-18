import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { isVoipMsWebhookAuthorized } from "./voipMsWebhookAuth";

const SECRET = "s3cr3t-webhook-value";

// ── The whole point: no secret ⇒ nobody is authorized ────────────────────────
// This is the regression that was live. `authorized` defaulted to
// `!cfg.webhookSecretEncrypted`, so an unconfigured secret authorized everyone.

test("refuses when no secret is configured (null)", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: null }), false);
});

test("refuses when no secret is configured (undefined)", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: undefined }), false);
});

test("refuses when the stored secret is empty or whitespace", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: "" }), false);
  assert.equal(isVoipMsWebhookAuthorized({ secret: "   " }), false);
});

test("refuses with no secret even when the caller presents credentials", () => {
  // The pre-fix code returned TRUE here — any caller was authorized.
  assert.equal(
    isVoipMsWebhookAuthorized({
      secret: null,
      headerSignature: "anything",
      tokenParam: "anything",
      signatureParam: "anything",
    }),
    false,
  );
});

test("refuses a caller presenting nothing when a secret IS configured", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: SECRET }), false);
});

test("refuses a wrong value in every position", () => {
  assert.equal(
    isVoipMsWebhookAuthorized({
      secret: SECRET,
      headerSignature: "nope",
      tokenParam: "nope",
      signatureParam: "nope",
    }),
    false,
  );
});

test("refuses a prefix of the secret (no truncation match)", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: SECRET, headerSignature: SECRET.slice(0, 5) }), false);
});

test("refuses the secret with extra trailing content", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: SECRET, tokenParam: `${SECRET}x` }), false);
});

// ── Accepts a genuinely correct presentation, in any of the three positions ──

test("accepts the secret in the x-voipms-signature header", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: SECRET, headerSignature: SECRET }), true);
});

test("accepts the secret in the token parameter", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: SECRET, tokenParam: SECRET }), true);
});

test("accepts the secret in the signature parameter", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: SECRET, signatureParam: SECRET }), true);
});

test("a configured secret is compared after trimming", () => {
  assert.equal(isVoipMsWebhookAuthorized({ secret: `  ${SECRET}  `, headerSignature: SECRET }), true);
});

// ── Guard the CALL SITE, not just the helper ────────────────────────────────
// The defect was in connectChatRoutes.ts's handler, so a unit test of the pure
// function alone passes straight through it. Read that file's source.

const routesSource = fs.readFileSync(path.join(__dirname, "connectChatRoutes.ts"), "utf8");

test("the webhook handler calls the fail-closed helper", () => {
  assert.ok(
    routesSource.includes("isVoipMsWebhookAuthorized({"),
    "connectChatRoutes.ts must authorize the VoIP.ms webhook through isVoipMsWebhookAuthorized",
  );
});

test("the fail-open default is gone", () => {
  assert.ok(
    !routesSource.includes("let authorized = !cfg.webhookSecretEncrypted"),
    "the fail-open default `let authorized = !cfg.webhookSecretEncrypted` must not come back",
  );
});

test("the 401 is no longer gated on the secret existing", () => {
  assert.ok(
    !routesSource.includes("if (!authorized && cfg.webhookSecretEncrypted)"),
    "refusing must not depend on a secret being configured — that is what made it fail open",
  );
});

test("the webhook refusal is not gated on NODE_ENV", () => {
  const idx = routesSource.indexOf("handleVoipMsInbound");
  const region = routesSource.slice(idx, idx + 3000);
  assert.ok(
    !region.includes("NODE_ENV"),
    "NODE_ENV is undefined in the api container, so any NODE_ENV gate here is permanently false",
  );
});
