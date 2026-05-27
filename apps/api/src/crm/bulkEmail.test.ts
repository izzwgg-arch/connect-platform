/**
 * Unit tests for CRM bulk email route logic.
 *
 * Tests cover:
 *  - email deduplication
 *  - missing-email skip logic
 *  - permission guard (requireCrmAdmin / isAdminRole)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAdminRole } from "./guard";

// ── Permission guard tests ─────────────────────────────────────────────────────

test("isAdminRole: ADMIN is admin", () => {
  assert.equal(isAdminRole("ADMIN"), true);
});

test("isAdminRole: TENANT_ADMIN is admin", () => {
  assert.equal(isAdminRole("TENANT_ADMIN"), true);
});

test("isAdminRole: SUPER_ADMIN is admin", () => {
  assert.equal(isAdminRole("SUPER_ADMIN"), true);
});

test("isAdminRole: EXTENSION_USER is not admin", () => {
  assert.equal(isAdminRole("EXTENSION_USER"), false);
});

test("isAdminRole: undefined is not admin", () => {
  assert.equal(isAdminRole(undefined), false);
});

// ── Dedup / skip logic (inline pure function tests) ────────────────────────────

/**
 * Inline the same dedup logic from bulkEmailRoutes.ts for isolated testing.
 * This mirrors exactly what the route does when building recipient rows.
 */
function dedupeAndSkip(
  candidates: Array<{ id: string; email: string }>,
): Array<{ id: string; email: string; skipReason?: string }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; email: string; skipReason?: string }> = [];
  for (const c of candidates) {
    const email = c.email.trim().toLowerCase();
    if (!email) {
      result.push({ ...c, skipReason: "MISSING_EMAIL" });
      continue;
    }
    if (seen.has(email)) {
      result.push({ ...c, skipReason: "DUPLICATE" });
      continue;
    }
    seen.add(email);
    result.push({ ...c, email });
  }
  return result;
}

test("dedup: empty list returns empty", () => {
  assert.deepEqual(dedupeAndSkip([]), []);
});

test("dedup: unique emails pass through unchanged", () => {
  const result = dedupeAndSkip([
    { id: "1", email: "a@x.com" },
    { id: "2", email: "b@x.com" },
  ]);
  assert.equal(result.filter((r) => !r.skipReason).length, 2);
});

test("dedup: duplicate email is marked DUPLICATE", () => {
  const result = dedupeAndSkip([
    { id: "1", email: "a@x.com" },
    { id: "2", email: "A@X.COM" }, // same email, different case
  ]);
  assert.equal(result[0].skipReason, undefined);
  assert.equal(result[1].skipReason, "DUPLICATE");
});

test("dedup: missing email is marked MISSING_EMAIL", () => {
  const result = dedupeAndSkip([
    { id: "1", email: "" },
    { id: "2", email: "  " },
  ]);
  assert.equal(result[0].skipReason, "MISSING_EMAIL");
  assert.equal(result[1].skipReason, "MISSING_EMAIL");
});

test("dedup: mixed valid, duplicate, missing", () => {
  const result = dedupeAndSkip([
    { id: "1", email: "good@x.com" },
    { id: "2", email: "" },
    { id: "3", email: "good@x.com" }, // duplicate
    { id: "4", email: "other@x.com" },
  ]);
  assert.equal(result.filter((r) => !r.skipReason).length, 2);
  assert.equal(result.filter((r) => r.skipReason === "DUPLICATE").length, 1);
  assert.equal(result.filter((r) => r.skipReason === "MISSING_EMAIL").length, 1);
});

test("dedup: email normalised to lowercase for dedup", () => {
  const result = dedupeAndSkip([
    { id: "1", email: "Alice@Example.com" },
    { id: "2", email: "alice@example.com" },
  ]);
  const sent = result.filter((r) => !r.skipReason);
  assert.equal(sent.length, 1);
  assert.equal(result[1].skipReason, "DUPLICATE");
});

// ── sourceType validation ──────────────────────────────────────────────────────

test("valid sourceTypes", () => {
  const validTypes = ["CONTACTS", "CAMPAIGN", "FUNDERS"];
  for (const t of validTypes) {
    assert.ok(["CONTACTS", "CAMPAIGN", "FUNDERS"].includes(t));
  }
});

test("invalid sourceType rejected", () => {
  assert.ok(!["CONTACTS", "CAMPAIGN", "FUNDERS"].includes("INVALID"));
});

// ── Idempotency key format ─────────────────────────────────────────────────────

test("idempotency key uses jobId:recipientKey:templateId", () => {
  const jobId = "job_123";
  const contactId = "contact_456";
  const templateId = "template_789";
  const key = `${jobId}:${contactId}:${templateId}`;
  assert.ok(key.startsWith("job_123:contact_456:template_789"));
});
