import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  LEGACY_ABSOLUTE_API_BASE,
  resolveAbsoluteApiBase,
  resolveSameOriginApiBase,
} from "./publicApiBase";

/* ── Case 1: the pay pages ──────────────────────────────────────────────────
   These fetch from the page the customer is already on. The answer must be
   same-origin (relative), so it is correct on EVERY hostname Connect is served
   on — the whole bug was that a hardcoded absolute domain turned every request
   from app.loopcom.net into a blocked cross-origin one. */

test("pay pages fetch same-origin, never a hardcoded domain", () => {
  assert.equal(resolveSameOriginApiBase(undefined), "/api");
  assert.equal(resolveSameOriginApiBase(null), "/api");
  assert.equal(resolveSameOriginApiBase(""), "/api");
  assert.equal(resolveSameOriginApiBase("   "), "/api");
});

test("the same-origin base is relative, so it carries no host at all", () => {
  const base = resolveSameOriginApiBase("");
  assert.ok(!/^https?:\/\//i.test(base), `expected a relative base, got ${base}`);
  assert.ok(!base.includes("connectcomunications.com"));
  assert.ok(!base.includes("loopcom.net"));
});

test("an explicit NEXT_PUBLIC_API_URL still wins (local dev points at :3001)", () => {
  assert.equal(resolveSameOriginApiBase("http://localhost:3001"), "http://localhost:3001");
  assert.equal(resolveSameOriginApiBase("http://localhost:3001/"), "http://localhost:3001");
  assert.equal(resolveSameOriginApiBase("https://app.loopcom.net/api//"), "https://app.loopcom.net/api");
});

/* ── Case 2: the pairing QR code ────────────────────────────────────────────
   This URL leaves the browser and is used by a PHONE. It must stay absolute —
   but derived from the origin the admin is actually on, not a baked-in domain. */

test("QR pairing yields an ABSOLUTE url — a relative one is useless to a phone", () => {
  const base = resolveAbsoluteApiBase("", "https://app.loopcom.net");
  assert.equal(base, "https://app.loopcom.net/api");
  assert.ok(/^https?:\/\//i.test(base));
});

test("QR pairing follows the hostname the admin is on", () => {
  assert.equal(
    resolveAbsoluteApiBase("", "https://app.connectcomunications.com"),
    "https://app.connectcomunications.com/api",
  );
  assert.equal(resolveAbsoluteApiBase("", "https://app.loopcom.net"), "https://app.loopcom.net/api");
  assert.equal(resolveAbsoluteApiBase("", "http://localhost:3000"), "http://localhost:3000/api");
});

test("QR pairing tolerates a trailing slash on the origin", () => {
  assert.equal(resolveAbsoluteApiBase("", "https://app.loopcom.net/"), "https://app.loopcom.net/api");
});

test("QR pairing honours an absolute NEXT_PUBLIC_API_URL over the origin", () => {
  assert.equal(
    resolveAbsoluteApiBase("http://localhost:3001", "https://app.loopcom.net"),
    "http://localhost:3001",
  );
});

test("a RELATIVE NEXT_PUBLIC_API_URL is made absolute for the QR, not passed through", () => {
  assert.equal(resolveAbsoluteApiBase("/api", "https://app.loopcom.net"), "https://app.loopcom.net/api");
  assert.equal(resolveAbsoluteApiBase("api", "https://app.loopcom.net"), "https://app.loopcom.net/api");
});

test("with no origin (server render) the QR base is still absolute, never relative", () => {
  const noOrigin = resolveAbsoluteApiBase("", null);
  assert.equal(noOrigin, LEGACY_ABSOLUTE_API_BASE);
  assert.ok(/^https?:\/\//i.test(noOrigin));

  const relativeEnvNoOrigin = resolveAbsoluteApiBase("/api", null);
  assert.ok(/^https?:\/\//i.test(relativeEnvNoOrigin));
});

/* ── The two cases must never be collapsed into one helper ─────────────────── */

test("the two resolvers deliberately disagree — same input, different shape", () => {
  const sameOrigin = resolveSameOriginApiBase("");
  const absolute = resolveAbsoluteApiBase("", "https://app.loopcom.net");
  assert.notEqual(sameOrigin, absolute);
  assert.ok(!/^https?:\/\//i.test(sameOrigin));
  assert.ok(/^https?:\/\//i.test(absolute));
});

/* ── The guard that actually matters: a CALL SITE regressing ────────────────
   The defect was never in a helper — it was four callers each carrying their own
   hardcoded domain. A unit test of the resolvers passes straight through that,
   so these read the call sites' SOURCE. */

const PORTAL_ROOT = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(PORTAL_ROOT, relativePath), "utf8");
}

const SAME_ORIGIN_CALL_SITES = [
  "app/p/[code]/page.tsx",
  "app/pay/invoice/[token]/page.tsx",
  "app/pay/invoices/[token]/page.tsx",
];

for (const relativePath of SAME_ORIGIN_CALL_SITES) {
  test(`${relativePath} carries no hardcoded API domain`, () => {
    const src = readSource(relativePath);
    assert.ok(
      !src.includes("app.connectcomunications.com"),
      `${relativePath} hardcodes a domain again — on the other hostname every fetch is a CORS failure`,
    );
    assert.ok(
      src.includes("resolveSameOriginApiBase(process.env.NEXT_PUBLIC_API_URL)"),
      `${relativePath} must resolve its API base through lib/publicApiBase.ts`,
    );
  });
}

test("the QR pairing modal builds an ABSOLUTE base from the live origin", () => {
  const src = readSource("components/QRPairingModal.tsx");
  assert.ok(
    !src.includes("app.connectcomunications.com"),
    "QRPairingModal hardcodes a domain again — phones paired from the other host would talk to the wrong one",
  );
  assert.ok(
    src.includes("resolveAbsoluteApiBase(process.env.NEXT_PUBLIC_API_URL, currentBrowserOrigin())"),
    "the QR base must be absolute AND derived from the current origin",
  );
  assert.ok(
    !src.includes("resolveSameOriginApiBase"),
    "⛔ the QR code must NOT use the same-origin resolver — a relative /api is useless to a phone",
  );
});
