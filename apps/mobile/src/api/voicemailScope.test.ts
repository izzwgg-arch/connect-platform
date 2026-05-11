/**
 * Run: pnpm --filter @connect/mobile test:voicemail-scope
 */
import assert from "node:assert/strict";
import test from "node:test";
import { voicemailQueryUserScope } from "./client";

function jwtToken(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `x.${b64}.y`;
}

test("voicemailQueryUserScope: different sub => different key", () => {
  const a = voicemailQueryUserScope(jwtToken({ sub: "u1", tenantId: "t1" }));
  const b = voicemailQueryUserScope(jwtToken({ sub: "u2", tenantId: "t1" }));
  assert.notEqual(a, b);
});

test("voicemailQueryUserScope: same payload => same key", () => {
  const tok = jwtToken({ sub: "u1", tenantId: "t1" });
  assert.equal(voicemailQueryUserScope(tok), voicemailQueryUserScope(tok));
});

test("voicemailQueryUserScope: null => stable anon bucket", () => {
  assert.equal(voicemailQueryUserScope(null), "_");
});
