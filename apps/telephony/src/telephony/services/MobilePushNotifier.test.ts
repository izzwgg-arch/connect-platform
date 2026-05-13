/**
 * MobilePushNotifier regression tests.
 *
 * These tests pin the post-`b5f8a43` (2026-05-06) behavior of
 * `MobilePushNotifier.notify()` and prevent the inbound-IVR self-ring
 * suppression bug from being reintroduced.
 *
 * Run:
 *     pnpm --filter @connect/telephony test
 *
 * Observable surface:
 *   - `globalThis.fetch` invocations: the only network observable for
 *     "did the API get notified?". Suppressed paths produce zero fetch
 *     calls; push paths produce exactly one fetch call per `toExtension`.
 *
 * Test design rules:
 *   - Tenant-generic. Cases use T2 / T11 / T18 explicitly to prove that
 *     no tenant id, DID, extension number, or PBX code is hardcoded into
 *     the decision logic.
 *   - No mocking of pino / logger.
 *   - No deploy. Do not import the running container's runtime state.
 *   - Pure black-box tests against the public `notify()` entrypoint.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Env bootstrap ─────────────────────────────────────────────────────────
//
// `apps/telephony/src/config/env.ts` validates required env on import. The
// `MobilePushNotifier` module transitively imports `env`, so `require()`-ing
// it without these set throws. We set them BEFORE the runtime require below.
//
// `LOG_LEVEL=fatal` keeps pino silent so test output stays readable.

process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";

// Late require so the env above is in place when the module's top-level
// `loadEnv()` runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MobilePushNotifier, looksDivertedToVoicemail } = require("./MobilePushNotifier");
// `import type` is erased and does not trigger env loading.
import type { NormalizedCall, CallDirection, CallState } from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeCall(overrides: Partial<NormalizedCall> & { linkedId: string }): NormalizedCall {
  return {
    id: overrides.linkedId,
    tenantId: null,
    tenantName: null,
    direction: "inbound" as CallDirection,
    state: "up" as CallState,
    from: null,
    fromName: null,
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
  };
}

type FetchCall = {
  url: string;
  body: {
    linkedId?: string;
    toExtension?: string;
    fromNumber?: string | null;
    fromDisplay?: string | null;
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
    return {
      ok: true,
      status: 200,
      text: async () => "",
    };
  };
  return {
    calls,
    restore: () => {
      (globalThis as unknown as { fetch: unknown }).fetch = original as unknown;
    },
  };
}

// `notify()` calls `postAsync(payload).catch(...)` which is fire-and-forget.
// We need to flush at least one tick so the async function reaches `fetch`
// (which is the synchronous-up-to-await stub above).
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// Some helpers for readable assertions across tenant/extension permutations.
function assertNoFetch(calls: FetchCall[], because: string): void {
  assert.equal(
    calls.length,
    0,
    `expected zero mobile-ring-notify POSTs (${because}); got ${calls.length}`,
  );
}

function assertSinglePush(
  calls: FetchCall[],
  expected: { toExtension: string; from?: string; tenantId?: string | null; pbxVitalTenantId?: string | null },
): void {
  assert.equal(calls.length, 1, `expected exactly one mobile-ring-notify POST, got ${calls.length}`);
  const [c] = calls;
  assert.match(c.url, /\/internal\/mobile-ring-notify$/, `unexpected POST url: ${c.url}`);
  assert.equal(c.body.toExtension, expected.toExtension, "toExtension mismatch");
  if (expected.from !== undefined) {
    assert.equal(c.body.fromNumber, expected.from, "fromNumber mismatch");
  }
  if (expected.tenantId !== undefined) {
    assert.equal(c.body.connectTenantId, expected.tenantId, "connectTenantId mismatch");
  }
  if (expected.pbxVitalTenantId !== undefined) {
    assert.equal(c.body.pbxVitalTenantId, expected.pbxVitalTenantId, "pbxVitalTenantId mismatch");
  }
}

// ─── Inbound external → tenant extension (REGRESSION COVERAGE) ────────────
//
// These three cases pin the original 2026-05-06 regression. The PBX rings
// both the desktop AOR (T<id>_<ext>) and the mobile companion AOR
// (T<id>_<ext>_1); MobilePushNotifier MUST issue exactly one
// /internal/mobile-ring-notify POST so the API can wake the killed mobile.

test("inbound external call → T2_103 / T2_103_1 fires exactly one mobile-ring-notify", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "1778094072.18393",
        direction: "inbound",
        state: "up",
        from: "8454226997",
        fromName: "A PLUS CENTER WIRELESS CALLER",
        to: "8457826775",
        source_extension: "103",
        extensions: ["103"],
        tenantId: "vpbx:a_plus_center",
        metadata: { pbxVitalTenantId: "2" },
      }),
    );
    await flush();
    assertSinglePush(calls, {
      toExtension: "103",
      from: "8454226997",
      tenantId: "vpbx:a_plus_center",
      pbxVitalTenantId: "2",
    });
  } finally {
    restore();
  }
});

test("inbound external call → T11_103 / T11_103_1 fires exactly one mobile-ring-notify", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-T11.1",
        direction: "inbound",
        state: "up",
        from: "9172421944",
        fromName: "TRIMPRO INC",
        to: "8455570001",
        source_extension: "103",
        extensions: ["T11_103"],
        tenantId: "vpbx:trimpro",
        metadata: { pbxVitalTenantId: "11" },
      }),
    );
    await flush();
    assertSinglePush(calls, {
      toExtension: "103",
      from: "9172421944",
      tenantId: "vpbx:trimpro",
      pbxVitalTenantId: "11",
    });
  } finally {
    restore();
  }
});

test("inbound external call → T18_105 / T18_105_1 fires exactly one mobile-ring-notify", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-T18.1",
        direction: "inbound",
        state: "up",
        from: "8453955956",
        fromName: "GESHEFT INBOUND",
        to: "8005550018",
        source_extension: "105",
        extensions: ["T18_105"],
        tenantId: "vpbx:tenant_t18",
        metadata: { pbxVitalTenantId: "18" },
      }),
    );
    await flush();
    assertSinglePush(calls, {
      toExtension: "105",
      from: "8453955956",
      tenantId: "vpbx:tenant_t18",
      pbxVitalTenantId: "18",
    });
  } finally {
    restore();
  }
});

// ─── Inbound: companion AOR (mobile alongside desktop) collapses to one push ─
//
// VitalPBX `T<id>_cos-all` dial commonly attaches BOTH the primary AOR
// (T<id>_<ext>) and the WebRTC companion (T<id>_<ext>_1) to the same call.
// `extractShortExtension` must reduce both forms to the same short ext, so
// MobilePushNotifier produces exactly one push per recipient extension —
// never two.

test("inbound: dual AOR (T<id>_<ext> + T<id>_<ext>_1) collapses to a single push", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-dualAOR.1",
        direction: "inbound",
        state: "up",
        from: "5551234567",
        to: "8001234567",
        source_extension: "103",
        // Both desktop AOR and mobile AOR appear because PJSIP_DIAL_CONTACTS
        // returned both reachable contacts. The notifier must NOT push twice.
        extensions: ["T2_103", "T2_103_1"],
        tenantId: "vpbx:a_plus_center",
        metadata: { pbxVitalTenantId: "2" },
      }),
    );
    await flush();
    assertSinglePush(calls, { toExtension: "103" });
  } finally {
    restore();
  }
});

// ─── Outbound: self-ring suppression MUST still work ───────────────────────
//
// The whole point of the `selfOriginatingExt` filter (lines 135-153 of
// MobilePushNotifier.ts) is to stop the originator's mobile companion from
// re-ringing as if the call were inbound. These tests pin that the
// outbound path remains suppressed across multiple tenants/extensions.

test("outbound external dial from T2_103 → PSTN: zero pushes (self-ring suppressed)", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-out.T2.1",
        direction: "outbound",
        state: "up",
        from: "103",
        to: "12124441100",
        source_extension: "103",
        extensions: ["103"],
        tenantId: "vpbx:a_plus_center",
        metadata: { pbxVitalTenantId: "2" },
      }),
    );
    await flush();
    assertNoFetch(calls, "outbound self-ring suppression for T2_103 → PSTN");
  } finally {
    restore();
  }
});

test("outbound external dial from T11_103 → PSTN: zero pushes (self-ring suppressed)", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-out.T11.1",
        direction: "outbound",
        state: "up",
        from: "103",
        to: "8455551234",
        source_extension: "103",
        extensions: ["T11_103"],
        tenantId: "vpbx:trimpro",
        metadata: { pbxVitalTenantId: "11" },
      }),
    );
    await flush();
    assertNoFetch(calls, "outbound self-ring suppression for T11_103 → PSTN");
  } finally {
    restore();
  }
});

test("outbound external dial from T18_105 → PSTN: zero pushes (self-ring suppressed)", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-out.T18.1",
        direction: "outbound",
        state: "up",
        from: "105",
        to: "9175557890",
        source_extension: "105",
        extensions: ["T18_105"],
        tenantId: "vpbx:tenant_t18",
        metadata: { pbxVitalTenantId: "18" },
      }),
    );
    await flush();
    assertNoFetch(calls, "outbound self-ring suppression for T18_105 → PSTN");
  } finally {
    restore();
  }
});

// ─── Internal extension-to-extension calls ────────────────────────────────
//
// On internal calls the receiver must be pushed (so a backgrounded mobile
// rings) but the caller must NOT be pushed back (no self-ring loop).

test("internal call: ext 108 → ext 103 pushes only the receiver (103), not the caller (108)", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-internal.1",
        direction: "internal",
        state: "up",
        from: "108",
        to: "103",
        source_extension: "108",
        extensions: ["108", "103"],
        tenantId: "vpbx:a_plus_center",
        metadata: { pbxVitalTenantId: "2" },
      }),
    );
    await flush();
    assertSinglePush(calls, { toExtension: "103", from: "108" });
  } finally {
    restore();
  }
});

// ─── Inbound, helper-only legs (extensions not yet resolved) ──────────────
//
// Early in an inbound call the only channel may be the trunk leg
// (PJSIP/<peer>) before the IVR creates the Local/<ext> child. The
// notifier should NOT push prematurely — the next callUpsert event will
// repopulate `extensions` once the ext leg appears. The dedupe set
// prevents the eventual push from firing twice.

test("inbound with empty extensions does NOT push (helper-only, will retry on next event)", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    notifier.notify(
      makeCall({
        linkedId: "test-empty-exts.1",
        direction: "inbound",
        state: "ringing",
        from: "5551112222",
        to: "8001112222",
        source_extension: null,
        extensions: [],
        tenantId: "vpbx:a_plus_center",
        metadata: { pbxVitalTenantId: "2" },
      }),
    );
    await flush();
    assertNoFetch(calls, "extensions not yet resolved");
  } finally {
    restore();
  }
});

// ─── Tenant-id agnostic: the same call shape produces the same decision ────
//
// The decision must not depend on the value of `tenantId` — it depends on
// `direction`, `to`, `source_extension`, and `extensions`. Run the same
// inbound shape against three unrelated tenant ids and assert the push
// fires identically each time. This guards against any future regression
// that accidentally hardcodes tenant assumptions.

test("decision is tenant-id agnostic across three arbitrary tenants", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    const tenantIds = [
      "vpbx:tenant_alpha",
      "vpbx:tenant_beta",
      "vpbx:tenant_gamma",
    ];
    let i = 0;
    for (const tenantId of tenantIds) {
      i += 1;
      notifier.notify(
        makeCall({
          linkedId: `test-tenant-agnostic.${i}`,
          direction: "inbound",
          state: "up",
          from: `555000${i}`,
          to: `800111${i}`,
          source_extension: "104",
          extensions: ["104"],
          tenantId,
          metadata: { pbxVitalTenantId: String(100 + i) },
        }),
      );
      await flush();
    }
    assert.equal(calls.length, 3, "expected one push per tenant invocation");
    for (let n = 0; n < 3; n += 1) {
      assert.equal(calls[n].body.toExtension, "104", `push #${n + 1} toExtension`);
      assert.equal(
        calls[n].body.connectTenantId,
        tenantIds[n],
        `push #${n + 1} tenantId passthrough`,
      );
    }
  } finally {
    restore();
  }
});

// ─── No DID / extension hardcoding: identical decisions across mixed numbers ─
//
// Same direction + same source_extension shape, but every numeric field
// (caller, DID, ext-number) is rotated. Decision must remain "push to the
// short extension". This catches any future change that smuggles a DID
// allowlist or specific extension number into the suppression path.

test("decision is DID-agnostic and extension-number-agnostic", async () => {
  const { calls, restore } = installFetchSpy();
  try {
    const notifier = new MobilePushNotifier();
    const cases = [
      { ext: "100", from: "9991110001", to: "8002220001", linkedId: "ext-prop-100" },
      { ext: "201", from: "9991110002", to: "8002220002", linkedId: "ext-prop-201" },
      { ext: "999", from: "9991110003", to: "8002220003", linkedId: "ext-prop-999" },
      { ext: "1234", from: "9991110004", to: "8002220004", linkedId: "ext-prop-1234" },
    ];
    for (const c of cases) {
      notifier.notify(
        makeCall({
          linkedId: c.linkedId,
          direction: "inbound",
          state: "up",
          from: c.from,
          to: c.to,
          source_extension: c.ext,
          extensions: [c.ext],
          tenantId: "vpbx:property_test",
          metadata: { pbxVitalTenantId: "999" },
        }),
      );
      await flush();
    }
    assert.equal(calls.length, cases.length, "one push per case");
    for (let n = 0; n < cases.length; n += 1) {
      assert.equal(
        calls[n].body.toExtension,
        cases[n].ext,
        `case ${n} toExtension matches input ext`,
      );
    }
  } finally {
    restore();
  }
});

test("looksDivertedToVoicemail detects voicemail channels and dialplan context", () => {
  assert.equal(
    looksDivertedToVoicemail(makeCall({ linkedId: "vm-ch", channels: ["Local/101@subVoicemail"] })),
    true,
  );
  assert.equal(
    looksDivertedToVoicemail(
      makeCall({
        linkedId: "vm-dcx",
        metadata: { cdrDcontext: "from-internal-t2_cos-all,103,1,app-voicemail,default,s,1" },
      }),
    ),
    true,
  );
  assert.equal(looksDivertedToVoicemail(makeCall({ linkedId: "no-vm", channels: ["PJSIP/T2_103-000"] })), false);
});
