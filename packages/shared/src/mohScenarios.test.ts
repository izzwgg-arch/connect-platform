// Requirement-12 scenario matrix for Connect Music-on-Hold.
//
// Each test maps 1:1 to a required call scenario and asserts the *pure* MOH
// decision that the dialplan resolver and publish path rely on. These are
// deterministic (no DB / AstDB / Asterisk) and encode the safety contract:
//   * every call resolves to a class OR to null (→ PBX default) — it NEVER
//     throws, so a lookup failure can never fail/hang a call;
//   * per-source policies only ADD specificity over the tenant/extension
//     default (additive, backwards-compatible);
//   * source classification is stable and tenant-scoped.
//
// The classifier signals mirror the dialplan MOH_SRC computation in
// scripts/pbx/install-connect-tenant-moh-dialplan.sh and the reference
// contexts in docs/pbx/option-a-custom-context.conf.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDialplanMohSource,
  resolveEffectiveMohClass,
  tenantSourceMohFamily,
  extensionSourceMohFamily,
} from "./mohCallSource";

// A representative tenant policy table: tenant default moh5, a couple of
// per-source tenant policies, one extension override, one extension per-source.
function resolveFor(opts: {
  source: Parameters<typeof resolveEffectiveMohClass>[0]["source"];
  scheduledExtensionClass?: string | null;
  extensionSourceClass?: string | null;
  extensionDefaultClass?: string | null;
  tenantSourceClass?: string | null;
  tenantDefaultClass?: string | null;
  globalDefaultClass?: string | null;
}) {
  return resolveEffectiveMohClass({
    source: opts.source,
    scheduledExtensionClass: opts.scheduledExtensionClass ?? null,
    extensionSourceClass: opts.extensionSourceClass ?? null,
    extensionDefaultClass: opts.extensionDefaultClass ?? null,
    tenantSourceClass: opts.tenantSourceClass ?? null,
    tenantDefaultClass: opts.tenantDefaultClass ?? null,
    globalDefaultClass: opts.globalDefaultClass ?? null,
  });
}

// ── 1. direct inbound to extension ───────────────────────────────────────────
test("scenario 1: direct inbound to extension → inbound_direct, tenant default", () => {
  assert.equal(classifyDialplanMohSource({ fromTrunk: true }), "inbound_direct");
  const r = resolveFor({ source: "inbound_direct", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh5");
  assert.equal(r.reason, "tenant_default");
});

// ── 2. inbound through IVR to extension ──────────────────────────────────────
test("scenario 2: inbound via IVR honors tenant inbound_ivr policy", () => {
  assert.equal(classifyDialplanMohSource({ ivr: true, fromTrunk: true }), "inbound_ivr");
  const r = resolveFor({ source: "inbound_ivr", tenantSourceClass: "moh_ivr", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_ivr");
  assert.equal(r.reason, "tenant_source");
});

// ── 3. inbound through ring group to extension ───────────────────────────────
test("scenario 3: inbound via ring group honors inbound_ringgroup policy", () => {
  assert.equal(classifyDialplanMohSource({ ringGroup: true, fromTrunk: true }), "inbound_ringgroup");
  const r = resolveFor({ source: "inbound_ringgroup", tenantSourceClass: "moh_rg", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_rg");
});

// ── 4. inbound through queue to extension ────────────────────────────────────
test("scenario 4: inbound via queue honors inbound_queue policy (queue behavior preserved elsewhere)", () => {
  assert.equal(classifyDialplanMohSource({ queue: true, fromTrunk: true }), "inbound_queue");
  const r = resolveFor({ source: "inbound_queue", tenantSourceClass: "moh_queue", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_queue");
});

// ── 5. internal extension-to-extension ───────────────────────────────────────
test("scenario 5: internal call with no signals → internal, extension override wins", () => {
  assert.equal(classifyDialplanMohSource({}), "internal");
  const r = resolveFor({ source: "internal", extensionDefaultClass: "moh_ext", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_ext");
  assert.equal(r.reason, "extension_default");
});

// ── 6. outbound call placed by extension ─────────────────────────────────────
test("scenario 6: outbound honors extension per-source policy over tenant", () => {
  assert.equal(classifyDialplanMohSource({ toTrunk: true }), "outbound");
  const r = resolveFor({ source: "outbound", extensionSourceClass: "moh_out_ext", tenantSourceClass: "moh_out_tenant", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_out_ext");
  assert.equal(r.reason, "extension_source");
});

// ── 7. attended transfer ─────────────────────────────────────────────────────
test("scenario 7: attended transfer classified as transfer", () => {
  assert.equal(classifyDialplanMohSource({ transfer: true }), "transfer");
  const r = resolveFor({ source: "transfer", tenantSourceClass: "moh_xfer", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_xfer");
});

// ── 8. blind transfer ────────────────────────────────────────────────────────
test("scenario 8: blind transfer also classified as transfer (folded by design)", () => {
  // Blind + attended both surface as BLINDTRANSFER/__TRANSFERED_CALL in the
  // dialplan; the taxonomy intentionally folds both to a single 'transfer'.
  assert.equal(classifyDialplanMohSource({ transfer: true, fromTrunk: true }), "transfer");
});

// ── 9. voicemail fallback ────────────────────────────────────────────────────
test("scenario 9: no MOH policy never breaks the call — resolves to null (PBX default)", () => {
  // Voicemail routing is untouched; if MOH lookup finds nothing the call must
  // continue on the PBX default. resolveEffectiveMohClass returns null, never throws.
  const r = resolveFor({ source: "internal" });
  assert.equal(r.class, null);
  assert.equal(r.reason, "pbx_default");
});

// ── 10. scheduled override active ────────────────────────────────────────────
test("scenario 10: active scheduled extension override beats every static level", () => {
  const r = resolveFor({
    source: "internal",
    scheduledExtensionClass: "moh_holiday",
    extensionSourceClass: "moh_ext_src",
    tenantDefaultClass: "moh5",
  });
  assert.equal(r.class, "moh_holiday");
  assert.equal(r.reason, "schedule_extension");
});

// ── 11. scheduled override expired/reverted ──────────────────────────────────
test("scenario 11: expired schedule (empty input) reverts to static policy", () => {
  const r = resolveFor({
    source: "internal",
    scheduledExtensionClass: "", // publish path emits empty once the window closes
    extensionSourceClass: "moh_ext_src",
    tenantDefaultClass: "moh5",
  });
  assert.equal(r.class, "moh_ext_src");
  assert.equal(r.reason, "extension_source");
});

// ── 12. tenant default fallback ──────────────────────────────────────────────
test("scenario 12: no ext/source policy → tenant default", () => {
  const r = resolveFor({ source: "inbound_direct", tenantDefaultClass: "moh5", globalDefaultClass: "moh_global" });
  assert.equal(r.class, "moh5");
  assert.equal(r.reason, "tenant_default");
});

// ── 13. extension override fallback ──────────────────────────────────────────
test("scenario 13: extension default used when no per-source ext policy exists", () => {
  const r = resolveFor({ source: "outbound", extensionDefaultClass: "moh_ext", tenantSourceClass: "moh_ten_src", tenantDefaultClass: "moh5" });
  assert.equal(r.class, "moh_ext");
  assert.equal(r.reason, "extension_default");
});

// ── 14. missing MOH file fallback ────────────────────────────────────────────
test("scenario 14: global default is the last Connect fallback before PBX default", () => {
  // If the tenant/extension classes are unset (e.g. dropped by the publish
  // readiness gate because their audio isn't ready) the global default applies.
  const r = resolveFor({ source: "internal", globalDefaultClass: "moh_global" });
  assert.equal(r.class, "moh_global");
  assert.equal(r.reason, "global_default");
});

// ── 15. tenant isolation ─────────────────────────────────────────────────────
test("scenario 15: AstDB families are tenant/extension scoped and reject traversal", () => {
  assert.equal(tenantSourceMohFamily("acme"), "connect/t_acme/moh/src");
  assert.equal(tenantSourceMohFamily("globex"), "connect/t_globex/moh/src");
  assert.notEqual(tenantSourceMohFamily("acme"), tenantSourceMohFamily("globex"));
  assert.throws(() => tenantSourceMohFamily("../acme"));
  assert.throws(() => extensionSourceMohFamily("acme", "../101"));
});

// ── 16. no loop regression ───────────────────────────────────────────────────
test("scenario 16: resolution is a pure decision — it yields a class token, not a route", () => {
  // The resolver only ever returns a class string or null; it has no notion of
  // Dial/Local/Goto. The dialplan uses it solely to Set(CHANNEL(musicclass)),
  // so no per-source policy can introduce a routing loop.
  const r = resolveFor({ source: "transfer", tenantSourceClass: "moh_xfer" });
  assert.equal(typeof r.class, "string");
  assert.ok(!/dial|local|goto/i.test(String(r.class)));
});

// ── 17. no duplicate call-leg regression ─────────────────────────────────────
test("scenario 17: same inputs are deterministic (idempotent) — no duplicate side effects", () => {
  const a = resolveFor({ source: "inbound_queue", tenantSourceClass: "moh_q", tenantDefaultClass: "moh5" });
  const b = resolveFor({ source: "inbound_queue", tenantSourceClass: "moh_q", tenantDefaultClass: "moh5" });
  assert.deepEqual(a, b);
});

// ── 18. full priority ladder in one pass ─────────────────────────────────────
test("scenario 18: full 6-level ladder resolves top-down deterministically", () => {
  const all = {
    scheduledExtensionClass: "L1",
    extensionSourceClass: "L2",
    extensionDefaultClass: "L3",
    tenantSourceClass: "L4",
    tenantDefaultClass: "L5",
    globalDefaultClass: "L6",
  };
  assert.equal(resolveFor({ source: "internal", ...all }).class, "L1");
  assert.equal(resolveFor({ source: "internal", ...all, scheduledExtensionClass: null }).class, "L2");
  assert.equal(resolveFor({ source: "internal", ...all, scheduledExtensionClass: null, extensionSourceClass: null }).class, "L3");
  assert.equal(resolveFor({ source: "internal", ...all, scheduledExtensionClass: null, extensionSourceClass: null, extensionDefaultClass: null }).class, "L4");
  assert.equal(resolveFor({ source: "internal", tenantDefaultClass: "L5", globalDefaultClass: "L6" }).class, "L5");
  assert.equal(resolveFor({ source: "internal", globalDefaultClass: "L6" }).class, "L6");
  assert.equal(resolveFor({ source: "internal" }).class, null);
});
