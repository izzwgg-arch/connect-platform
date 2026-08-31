import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validatePortDetails,
  validateScopedExtensions,
  type PortingFields,
  type WizExtension,
} from "../app/onboarding/[token]/scopedFlows";

/**
 * Scoped onboarding links — "just submit a port" / "just add extensions".
 *
 * The source guards pin WIRING a refactor can silently drop: the full wizard
 * and the port-only link must render/validate the port fields through ONE
 * shared implementation (the two-publish-paths drift rule), and the scoped
 * branch must render before the mobile-wizard branch or a phone visitor gets
 * the full sign-up.
 */

function read(p: string): string {
  return readFileSync(resolve(__dirname, p), "utf8").replace(/\r\n/g, "\n");
}
const pageSrc = read("../app/onboarding/[token]/page.tsx");
const adminSrc = read("../app/(platform)/admin/onboarding/page.tsx");

// ── Unit: the shared validations ─────────────────────────────────────────────
const GOOD_PORT: PortingFields = {
  carrier: "Verizon", numbers: "(845) 555-0123", accountNumber: "A-1",
  nameOnAccount: "Acme", serviceAddress: "12 Main St", serviceCity: "Monsey",
  serviceState: "NY", serviceZip: "10952", isMobile: false, portPin: "",
  loaFileName: "", billFileName: "", loaSignature: "Jane Smith",
};

test("validatePortDetails: a complete landline port passes", () => {
  assert.equal(validatePortDetails(GOOD_PORT), null);
});

test("validatePortDetails: a cell number needs the transfer PIN", () => {
  assert.match(validatePortDetails({ ...GOOD_PORT, isMobile: true, portPin: "" }) || "", /transfer PIN/);
  assert.equal(validatePortDetails({ ...GOOD_PORT, isMobile: true, portPin: "1234" }), null);
});

test("validatePortDetails: the typed signature is mandatory — it IS the LOA", () => {
  assert.match(validatePortDetails({ ...GOOD_PORT, loaSignature: "" }) || "", /full name/);
});

const GOOD_EXT: WizExtension = { displayName: "Jane", extNumber: "101", email: "", vmPassword: "", cellMode: "", cellNumber: "", isOwner: false };

test("validateScopedExtensions: NO owner-email rule — these people join an EXISTING account", () => {
  // The full wizard requires the owner to carry an email; the scoped flow must
  // not, since nobody here becomes the account admin.
  assert.equal(validateScopedExtensions([{ ...GOOD_EXT, isOwner: true, email: "" }]), null);
});

test("validateScopedExtensions: duplicates, short extensions, bad emails and half cells refuse", () => {
  assert.match(validateScopedExtensions([GOOD_EXT, { ...GOOD_EXT, displayName: "B" }]) || "", /unique/);
  assert.match(validateScopedExtensions([{ ...GOOD_EXT, extNumber: "1" }]) || "", /three digits/);
  assert.match(validateScopedExtensions([{ ...GOOD_EXT, email: "nope" }]) || "", /email/);
  assert.match(validateScopedExtensions([{ ...GOOD_EXT, cellMode: "also", cellNumber: "555" }]) || "", /cell phone number/);
  assert.match(validateScopedExtensions([]) || "", /at least one/);
});

// ── Source guards ────────────────────────────────────────────────────────────

test("source guard: the wizard's port step renders the SHARED PortDetailsSection, not a second copy", () => {
  assert.ok(pageSrc.includes("<PortDetailsSection"), "page must render the shared section");
  // The old inline markup must be GONE from the page — its survival is exactly
  // the two-implementations drift this extraction exists to prevent.
  assert.ok(!pageSrc.includes('className="ob-porting-details"'), "the inline port block must not survive in page.tsx");
});

test("source guard: the wizard's port validation delegates to validatePortDetails", () => {
  assert.ok(pageSrc.includes("validatePortDetails(f.porting)"));
  assert.ok(
    !pageSrc.includes("Sign the transfer authorization"),
    "the port validation strings must live ONLY in scopedFlows.ts — a copy here will drift",
  );
});

test("source guard: the scoped branch renders BEFORE the mobile-wizard branch", () => {
  const scopedAt = pageSrc.indexOf('if (linkKind !== "full")');
  const phoneAt = pageSrc.indexOf("if (isPhone)");
  assert.ok(scopedAt > 0 && phoneAt > 0);
  assert.ok(scopedAt < phoneAt, "a phone visitor on a scoped link must get the scoped flow, never the full mobile wizard");
});

test("source guard: the scoped submits post the scoped endpoints, and linkKind hydrates from answers", () => {
  assert.ok(pageSrc.includes("/submit-port`"));
  assert.ok(pageSrc.includes("/submit-extensions`"));
  assert.ok(pageSrc.includes('a.linkKind === "port" || a.linkKind === "extension"'));
});

test("source guard: the admin invite card offers the three link types and sends `kind`", () => {
  assert.ok(adminSrc.includes('"Transfer a number only"'));
  assert.ok(adminSrc.includes('"Add extensions only"'));
  assert.match(adminSrc, /send,\s*kind\s*\}/, "create() must pass kind to the invitations POST");
});
