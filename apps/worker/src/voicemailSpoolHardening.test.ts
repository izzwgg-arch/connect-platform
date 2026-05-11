/**
 * Voicemail spool reconcile / helper hardening — pure and fetch-mocked tests (no DB).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  comparePbxHelperDottedVersion,
  fetchAllVoicemailSpoolMessages,
  pbxHelperVersionMeetsMin,
} from "@connect/integrations";
import { vmStablePbxMessageId } from "@connect/shared";
import { evaluateVoicemailSpoolReconcileHealth } from "./voicemailSpoolReconcileCycle";

test("pbxHelperVersionMeetsMin compares dotted calendar versions", () => {
  assert.equal(pbxHelperVersionMeetsMin("2026.05.10.1", "2026.05.10.1"), true);
  assert.equal(pbxHelperVersionMeetsMin("2026.05.10.2", "2026.05.10.1"), true);
  assert.equal(pbxHelperVersionMeetsMin("2026.05.09.9", "2026.05.10.1"), false);
  assert.equal(pbxHelperVersionMeetsMin(undefined, "2026.05.10.1"), false);
  assert.ok(comparePbxHelperDottedVersion("2026.05.10.1", "2026.05.10.1") === 0);
});

test("evaluateVoicemailSpoolReconcileHealth marks unhealthy for schema2 / pagination / version", () => {
  const ok = evaluateVoicemailSpoolReconcileHealth({
    helperVersionOkGlobal: true,
    schema2RequiredViolations: 0,
    paginationIncompleteMailboxes: 0,
    helperErrors: 0,
    totalInserted: 0,
    staleHighRiskIncreased: false,
  });
  assert.equal(ok.unhealthy, false);

  const bad = evaluateVoicemailSpoolReconcileHealth({
    helperVersionOkGlobal: false,
    schema2RequiredViolations: 2,
    paginationIncompleteMailboxes: 1,
    helperErrors: 1,
    totalInserted: 3,
    staleHighRiskIncreased: true,
  });
  assert.equal(bad.unhealthy, true);
  assert.ok(bad.reasons.length >= 5);
});

test("vmStablePbxMessageId is isolated per Connect tenant when msg_id absent (composite key)", () => {
  const base = {
    extNumber: "101",
    origtime: "1700000000",
    callerDigits: "5551234567",
  };
  const idA = vmStablePbxMessageId({ ...base, pbxTenantIdOrTenantCuid: "tenant_cuid_a" });
  const idB = vmStablePbxMessageId({ ...base, pbxTenantIdOrTenantCuid: "tenant_cuid_b" });
  assert.notEqual(idA, idB);
});

test("fetchAllVoicemailSpoolMessages follows schema-2 pagination across 450 rows", async () => {
  const orig = globalThis.fetch;
  let listCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!u.includes("/voicemail/spool/list")) {
      return orig(input, init);
    }
    listCalls++;
    const body = JSON.parse(String(init?.body || "{}")) as { offset?: number; limit?: number };
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 2000;
    const total = 450;
    const batch: Array<{
      folder: string;
      origtime: string;
      callerid: string;
      duration: string;
      filename: string;
      msg_num: string;
      recfile: string;
    }> = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      batch.push({
        folder: "INBOX",
        origtime: String(1_000_000 + i),
        callerid: "",
        duration: "1",
        filename: `msg${i}.wav`,
        msg_num: String(i),
        recfile: "",
      });
    }
    const sliceEnd = Math.min(offset + limit, total);
    const truncated = sliceEnd < total;
    return new Response(
      JSON.stringify({
        ok: true,
        mailboxPath: "/mock",
        messages: batch,
        spoolListSchema: 2,
        totalCount: total,
        returnedCount: batch.length,
        offset,
        limit,
        truncated,
        maxOrigtimeAll: String(1_000_000 + total - 1),
      }),
      { status: 200 },
    );
  };
  try {
    const merged = await fetchAllVoicemailSpoolMessages(
      { baseUrl: "http://helper-mock", secret: "secret" },
      { tenantId: "T1", extension: "101" },
      { pageSize: 200, timeoutMs: 5000, maxPages: 10 },
    );
    assert.equal(merged.messages.length, 450);
    assert.equal(merged.paginationComplete, true);
    assert.equal(merged.spoolListSchema, 2);
    assert.ok(listCalls >= 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test("legacy helper (no schema 2) returns single merged page without spoolListSchema 2", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!u.includes("/voicemail/spool/list")) {
      return orig(input, init);
    }
    return new Response(
      JSON.stringify({
        ok: true,
        mailboxPath: "/mock",
        messages: [
          {
            folder: "INBOX",
            origtime: "100",
            callerid: "",
            duration: "1",
            filename: "a.wav",
            msg_num: "1",
            recfile: "",
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const merged = await fetchAllVoicemailSpoolMessages(
      { baseUrl: "http://helper-legacy", secret: "secret" },
      { tenantId: "T1", extension: "101" },
      { pageSize: 200, timeoutMs: 5000, maxPages: 5 },
    );
    assert.equal(merged.spoolListSchema, undefined);
    assert.equal(merged.paginationComplete, true);
    assert.equal(merged.messages.length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});
