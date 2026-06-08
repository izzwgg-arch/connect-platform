import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  buildAllocateRequest,
  parseStunMessage,
  longTermKey,
  parseRelayUrlForProbe,
} from "./turnProbe";

test("parseRelayUrlForProbe: maps schemes/transports to probe targets", () => {
  assert.deepEqual(parseRelayUrlForProbe("turn:45.14.194.179:3478?transport=udp"), {
    host: "45.14.194.179", port: 3478, transport: "udp",
  });
  assert.deepEqual(parseRelayUrlForProbe("turn:45.14.194.179:3478?transport=tcp"), {
    host: "45.14.194.179", port: 3478, transport: "tcp",
  });
  assert.deepEqual(parseRelayUrlForProbe("turns:app.connectcomunications.com:5349?transport=tcp"), {
    host: "app.connectcomunications.com", port: 5349, transport: "tls",
  });
  assert.deepEqual(parseRelayUrlForProbe("turn:host.example"), {
    host: "host.example", port: 3478, transport: "udp",
  });
  assert.equal(parseRelayUrlForProbe("stun:host:3478"), null);
});

const MAGIC = 0x2112a442;

test("buildAllocateRequest: unauthenticated leg has valid header + REQUESTED-TRANSPORT", () => {
  const txId = Buffer.alloc(12, 7);
  const msg = buildAllocateRequest({ transactionId: txId });
  assert.equal(msg.readUInt16BE(0), 0x0003, "Allocate request type");
  assert.equal(msg.readUInt32BE(4), MAGIC, "magic cookie");
  assert.deepEqual(msg.subarray(8, 20), txId, "transaction id");
  const parsed = parseStunMessage(msg);
  assert.ok(parsed);
  assert.ok(parsed!.attrs.has(0x0019), "has REQUESTED-TRANSPORT");
  const rt = parsed!.attrs.get(0x0019)!;
  assert.equal(rt[0], 17, "UDP transport (17)");
});

test("buildAllocateRequest: header length matches actual attribute bytes (unauth)", () => {
  const msg = buildAllocateRequest({ transactionId: Buffer.alloc(12, 1) });
  const declaredLen = msg.readUInt16BE(2);
  assert.equal(declaredLen, msg.length - 20);
});

test("longTermKey: MD5(username:realm:password)", () => {
  const key = longTermKey("1700000000", "app.connectcomunications.com", "pw");
  const expected = createHash("md5").update("1700000000:app.connectcomunications.com:pw").digest();
  assert.deepEqual(key, expected);
});

test("buildAllocateRequest: signed leg carries USERNAME/REALM/NONCE/MESSAGE-INTEGRITY/FINGERPRINT", () => {
  const txId = Buffer.alloc(12, 2);
  const auth = { username: "1700000000", realm: "realm.test", nonce: "abc123", password: "secret" };
  const msg = buildAllocateRequest({ transactionId: txId, auth });
  const parsed = parseStunMessage(msg);
  assert.ok(parsed);
  assert.equal(parsed!.attrs.get(0x0006)!.toString("utf8"), auth.username, "USERNAME");
  assert.equal(parsed!.attrs.get(0x0014)!.toString("utf8"), auth.realm, "REALM");
  assert.equal(parsed!.attrs.get(0x0015)!.toString("utf8"), auth.nonce, "NONCE");
  assert.equal(parsed!.attrs.get(0x0008)!.length, 20, "MESSAGE-INTEGRITY is 20 bytes");
  assert.equal(parsed!.attrs.get(0x8028)!.length, 4, "FINGERPRINT is 4 bytes");
});

test("signed leg: MESSAGE-INTEGRITY verifies with the long-term key", () => {
  const txId = Buffer.alloc(12, 3);
  const auth = { username: "1700000000", realm: "realm.test", nonce: "n0nce", password: "secret" };
  const msg = buildAllocateRequest({ transactionId: txId, auth });

  // Locate the MESSAGE-INTEGRITY attribute boundary by walking attributes.
  let off = 20;
  const end = 20 + msg.readUInt16BE(2);
  let miStart = -1;
  let miValue: Buffer | null = null;
  while (off + 4 <= end) {
    const atype = msg.readUInt16BE(off);
    const alen = msg.readUInt16BE(off + 2);
    if (atype === 0x0008) {
      miStart = off;
      miValue = msg.subarray(off + 4, off + 4 + alen);
      break;
    }
    off += 4 + ((alen + 3) & ~3);
  }
  assert.ok(miStart > 0 && miValue, "found MESSAGE-INTEGRITY");

  // Recompute integrity over header (with length up to+including MI) + preceding attrs.
  const preMi = msg.subarray(20, miStart);
  const header = Buffer.from(msg.subarray(0, 20));
  header.writeUInt16BE(preMi.length + 24, 2);
  const key = longTermKey(auth.username, auth.realm, auth.password);
  const expected = createHmac("sha1", key).update(Buffer.concat([header, preMi])).digest();
  assert.deepEqual(miValue, expected, "MESSAGE-INTEGRITY matches RFC 5389 computation");
});

test("parseStunMessage: rejects non-STUN / short buffers", () => {
  assert.equal(parseStunMessage(Buffer.alloc(4)), null);
  const bad = Buffer.alloc(20);
  bad.writeUInt32BE(0xdeadbeef, 4); // wrong magic cookie
  assert.equal(parseStunMessage(bad), null);
});
