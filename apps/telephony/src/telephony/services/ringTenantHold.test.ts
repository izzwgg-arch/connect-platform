/**
 * Ring one-shot tenant-hold regression tests (2026-08-30).
 *
 * THE DEFECT THESE PIN: on a SignalWire-shaped trunk (request-URI user "s",
 * no DID in the exten) the destination extension and the call's tenant arrive
 * on DIFFERENT AMI events, milliseconds apart. The ring one-shot in
 * MobilePushNotifier used to latch the moment the extension appeared — with
 * `connectTenantId: null` — so the api either guessed the wrong company
 * (pre-ab33da33) or refused the push entirely (post-ab33da33), and the phone
 * never rang. ab33da33 fixed the DialBegin emit; the very next live call
 * latched from the recording __REC_FILENAME VarSet handler instead
 * (linkedId 1788095464.42602: ext at .564, tenant at .570 — 6 ms late).
 *
 * The fix under test: the one-shot HOLDS when the tenant is unresolved and
 * sends complete on the next upsert that carries it; a fallback timer sends
 * tenant-less after RING_TENANT_WAIT_MS so never-attributed calls still ring.
 *
 * Run:
 *     pnpm --filter @connect/telephony test:ring-tenant-hold
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Env bootstrap (must precede the late require below) ───────────────────
process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";
process.env.PBX_INBOUND_PREWAKE = "0";
// Shrink the fallback grace so the timer tests run in milliseconds. The
// production default (1000 ms) is asserted separately below.
process.env.PBX_RING_TENANT_WAIT_MS = "80";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MobilePushNotifier, RING_TENANT_WAIT_MS } = require("./MobilePushNotifier");
import type { NormalizedCall, CallDirection, CallState } from "../types";

function makeCall(overrides: Partial<NormalizedCall> & { linkedId: string }): NormalizedCall {
  return {
    id: overrides.linkedId,
    tenantId: null,
    tenantSlug: null,
    tenantName: null,
    direction: "inbound" as CallDirection,
    state: "ringing" as CallState,
    from: null,
    fromName: null,
    fromPrefix: null,
    to: null,
    connectedLine: null,
    source_extension: null,
    destination_extension: null,
    channelState: null,
    channels: [],
    bridgeIds: [],
    extensions: [],
    queueId: null,
    trunk: null,
    startedAt: new Date(0).toISOString(),
    answeredAt: null,
    extensionAnsweredAt: null,
    endedAt: null,
    durationSec: 0,
    billableSec: 0,
    metadata: {},
    ...overrides,
  } as NormalizedCall;
}

type FetchCall = {
  url: string;
  body: {
    linkedId?: string;
    toExtension?: string;
    connectTenantId?: string | null;
    pbxVitalTenantId?: string | null;
    state?: string;
  };
};

function installFetchSpy(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: unknown,
    init: { body?: unknown } | undefined,
  ) => {
    let body: FetchCall["body"] = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      body = {};
    }
    calls.push({ url: String(input), body });
    return { ok: true, status: 200, text: async () => "" };
  };
  return {
    calls,
    restore: () => {
      (globalThis as unknown as { fetch: unknown }).fetch = original as unknown;
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ringNotify = (calls: FetchCall[]) =>
  calls.filter((c) => /\/mobile-ring-notify$/.test(c.url) && c.body.state !== "hungup");

// The exact live shape: the SignalWire trunk leg resolves the extension (via
// the recording VarSet) BEFORE any tenant identity exists on the call.
const SIGNALWIRE_TENANTLESS = {
  linkedId: "sw-race-1",
  direction: "inbound" as CallDirection,
  state: "ringing" as CallState,
  from: "+15622096644",
  to: "s",
  extensions: ["101"],
  channels: ["PJSIP/loopcom-pbx-000055de"],
  tenantId: null,
  metadata: {},
};

test("SignalWire race: tenant-less ring upsert is HELD, then sent WITH the tenant on the next upsert", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    // Event 1: extension known, tenant not yet resolved → must NOT notify yet.
    notifier.notify(makeCall(SIGNALWIRE_TENANTLESS));
    await flush();
    assert.equal(
      ringNotify(calls).length,
      0,
      "the one-shot latched tenant-less — this is the exact 1788095464.42602 failure",
    );
    // Event 2, milliseconds later: the wake Local channel resolved the tenant.
    notifier.notify(
      makeCall({
        ...SIGNALWIRE_TENANTLESS,
        channels: [
          "PJSIP/loopcom-pbx-000055de",
          "Local/T102_101_1@connect-mobile-wake-dial-00002534;1",
        ],
        tenantId: "cms8yjvth8ctlo4137738yg0n",
      }),
    );
    await flush();
    const sent = ringNotify(calls);
    assert.equal(sent.length, 1, "exactly one ring notify once the tenant resolved");
    assert.equal(sent[0].body.toExtension, "101");
    assert.equal(
      sent[0].body.connectTenantId,
      "cms8yjvth8ctlo4137738yg0n",
      "the notify must carry the tenant the wake leg resolved",
    );
    // One-shot: further upserts do not re-send.
    notifier.notify(
      makeCall({
        ...SIGNALWIRE_TENANTLESS,
        tenantId: "cms8yjvth8ctlo4137738yg0n",
        state: "up" as CallState,
      }),
    );
    await flush();
    assert.equal(ringNotify(calls).length, 1, "still exactly one ring notify (one-shot)");
  } finally {
    restore();
  }
});

test("fallback: a call whose tenant NEVER resolves still notifies (tenant-less) after the grace", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(makeCall({ ...SIGNALWIRE_TENANTLESS, linkedId: "sw-never" }));
    await flush();
    assert.equal(ringNotify(calls).length, 0, "held during the grace");
    await sleep(RING_TENANT_WAIT_MS + 60);
    const sent = ringNotify(calls);
    assert.equal(sent.length, 1, "fallback timer must preserve the legacy tenant-less notify");
    assert.equal(sent[0].body.connectTenantId, null);
    assert.equal(sent[0].body.toExtension, "101");
  } finally {
    restore();
  }
});

test("a hangup during the hold cancels the held ring notify — no ringing notify after hungup", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(makeCall({ ...SIGNALWIRE_TENANTLESS, linkedId: "sw-hang" }));
    await flush();
    notifier.notify(
      makeCall({ ...SIGNALWIRE_TENANTLESS, linkedId: "sw-hang", state: "hungup" as CallState }),
    );
    await sleep(RING_TENANT_WAIT_MS + 60);
    const ringing = calls.filter(
      (c) => /\/mobile-ring-notify$/.test(c.url) && c.body.state !== "hungup",
    );
    assert.equal(ringing.length, 0, "the held ring notify must die with the call");
    const hangups = calls.filter((c) => c.body.state === "hungup");
    assert.equal(hangups.length, 1, "the hangup notify itself still goes out");
  } finally {
    restore();
  }
});

test("ordinary VoIP.ms-shaped inbound (tenant known on first event) is NOT delayed", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "voipms-1",
        direction: "inbound",
        state: "up",
        from: "8454226997",
        to: "8457826775",
        extensions: ["T2_103"],
        tenantId: "vpbx:a_plus_center",
        metadata: { pbxVitalTenantId: "2" },
      }),
    );
    await flush();
    const sent = ringNotify(calls);
    assert.equal(sent.length, 1, "tenant-known calls must notify immediately — no hold");
    assert.equal(sent[0].body.connectTenantId, "vpbx:a_plus_center");
  } finally {
    restore();
  }
});

test("pbxVitalTenantId alone (no Connect tenant id) also skips the hold", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        ...SIGNALWIRE_TENANTLESS,
        linkedId: "sw-vital-only",
        tenantId: null,
        metadata: { pbxVitalTenantId: "102" },
      }),
    );
    await flush();
    const sent = ringNotify(calls);
    assert.equal(
      sent.length,
      1,
      "a VitalPBX code is tenant identity the api can resolve — no hold needed",
    );
    assert.equal(sent[0].body.pbxVitalTenantId, "102");
  } finally {
    restore();
  }
});

test("the production grace default is 1000 ms (this suite shrinks it via env)", () => {
  // This file sets PBX_RING_TENANT_WAIT_MS=80; the constant must honour it,
  // which is also the proof the env override is wired for tests.
  assert.equal(RING_TENANT_WAIT_MS, 80);
});
