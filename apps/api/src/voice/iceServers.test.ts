import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  generateTurnCredentials,
  classifyIceServers,
  assertIceServersHaveRelayFallback,
  IceFallbackError,
  expandTurnHostToUrls,
  buildIceServers,
} from "./iceServers";

test("generateTurnCredentials: username is expiry, credential is HMAC-SHA1(secret, username)", () => {
  const nowMs = 1_700_000_000_000;
  const { username, credential } = generateTurnCredentials("s3cr3t", 3600, nowMs);
  assert.equal(username, String(Math.floor(nowMs / 1000) + 3600));
  const expected = createHmac("sha1", "s3cr3t").update(username).digest("base64");
  assert.equal(credential, expected);
});

test("classifyIceServers: detects udp / tcp / tls relay transports", () => {
  const s = classifyIceServers([
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:1.2.3.4:3478?transport=udp" },
    { urls: "turn:1.2.3.4:3478?transport=tcp" },
    { urls: "turns:turn.example.com:5349?transport=tcp" },
  ]);
  assert.equal(s.hasStun, true);
  assert.equal(s.hasTurnUdp, true);
  assert.equal(s.hasTurnTcp, true);
  assert.equal(s.hasTurnsTls, true);
  assert.equal(s.turnCount, 3);
});

test("classifyIceServers: turn: with no transport counts as UDP", () => {
  const s = classifyIceServers([{ urls: "turn:1.2.3.4:3478" }]);
  assert.equal(s.hasTurnUdp, true);
  assert.equal(s.hasTurnTcp, false);
  assert.equal(s.hasTurnsTls, false);
});

test("guard: UDP-only TURN throws (the 2026-06-08 regression)", () => {
  const udpOnly = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:45.14.194.179:3478" },
  ];
  assert.throws(
    () => assertIceServersHaveRelayFallback(udpOnly, { turnEnabled: true }),
    (err: unknown) => err instanceof IceFallbackError && err.code === "ICE_CONFIG_NO_RELAY_FALLBACK",
  );
});

test("guard: TURN enabled but zero relay urls throws", () => {
  assert.throws(
    () => assertIceServersHaveRelayFallback([{ urls: "stun:stun.l.google.com:19302" }], { turnEnabled: true }),
    (err: unknown) => err instanceof IceFallbackError,
  );
});

test("guard: TCP fallback present is accepted", () => {
  const s = assertIceServersHaveRelayFallback(
    [
      { urls: "turn:1.2.3.4:3478?transport=udp" },
      { urls: "turn:1.2.3.4:3478?transport=tcp" },
    ],
    { turnEnabled: true },
  );
  assert.equal(s.hasTurnTcp, true);
});

test("guard: TLS fallback present is accepted", () => {
  const s = assertIceServersHaveRelayFallback(
    [
      { urls: "turn:1.2.3.4:3478?transport=udp" },
      { urls: "turns:turn.example.com:5349?transport=tcp" },
    ],
    { turnEnabled: true },
  );
  assert.equal(s.hasTurnsTls, true);
});

test("guard: no-op when TURN disabled", () => {
  assert.doesNotThrow(() =>
    assertIceServersHaveRelayFallback([{ urls: "stun:stun.l.google.com:19302" }], { turnEnabled: false }),
  );
});

test("expandTurnHostToUrls: bare IP expands to udp + tcp", () => {
  assert.deepEqual(expandTurnHostToUrls("45.14.194.179"), [
    "turn:45.14.194.179:3478?transport=udp",
    "turn:45.14.194.179:3478?transport=tcp",
  ]);
});

test("expandTurnHostToUrls: host:port suffix is normalized", () => {
  assert.deepEqual(expandTurnHostToUrls("turn.example.com:3478"), [
    "turn:turn.example.com:3478?transport=udp",
    "turn:turn.example.com:3478?transport=tcp",
  ]);
});

test("expandTurnHostToUrls: already-qualified url passes through", () => {
  assert.deepEqual(expandTurnHostToUrls("turns:turn.example.com:5349?transport=tcp"), [
    "turns:turn.example.com:5349?transport=tcp",
  ]);
});

test("buildIceServers: attaches HMAC creds to every relay entry and produces a usable fallback set", () => {
  const ice = buildIceServers({
    stunUrls: ["stun:stun.l.google.com:19302"],
    turnUrls: [
      "turn:45.14.194.179:3478?transport=udp",
      "turn:45.14.194.179:3478?transport=tcp",
      "turns:app.connectcomunications.com:5349?transport=tcp",
    ],
    authSecret: "shared-secret",
    nowMs: 1_700_000_000_000,
  });
  const relays = ice.filter((e) => /^turns?:/i.test(e.urls));
  assert.equal(relays.length, 3);
  for (const r of relays) {
    assert.ok(r.username, "relay entry has username");
    assert.ok(r.credential, "relay entry has credential");
  }
  // The produced set must satisfy the fallback guard.
  assert.doesNotThrow(() => assertIceServersHaveRelayFallback(ice, { turnEnabled: true }));
});

test("buildIceServers: falls back to static creds when no auth secret", () => {
  const ice = buildIceServers({
    stunUrls: [],
    turnUrls: ["turn:1.2.3.4:3478?transport=tcp"],
    staticUsername: "user",
    staticCredential: "pass",
  });
  assert.equal(ice[0].username, "user");
  assert.equal(ice[0].credential, "pass");
});
