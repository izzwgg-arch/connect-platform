// Customer tracking routes (Phase 6). GET /track/:token is PUBLIC (no JWT) — it must be in
// the server's JWT-skip list. Mint/revoke are dispatcher-gated.

import { requireDeliveryDispatch } from "./guard";
import { resolveTrackingView, verifyTrackingOtp, mintTrackingLink, revokeTrackingLinks } from "./customerTrackingService";

export async function registerDeliveryCustomerRoutes(app: any): Promise<void> {
  // ── Public: resolve a tracking token → privacy-filtered view ────────────────
  app.get("/track/:token", async (req: any, reply: any) => {
    const token = String(req.params?.token || "");
    if (!token || token.length < 8) return reply.status(200).send({ state: "invalid" });
    // Optional inline OTP verification (?code=…) so the customer page can verify in one call.
    const code = String(req.query?.code || "").trim();
    if (code) await verifyTrackingOtp(token, code);
    const result = await resolveTrackingView(token);
    // Always 200 with a state — never leak existence via status codes (anti-enumeration).
    return reply.send(result);
  });

  // ── Public: verify OTP to unlock tier-2 detail ──────────────────────────────
  app.post("/track/:token/verify", async (req: any, reply: any) => {
    const token = String(req.params?.token || "");
    const code = String(req.body?.code || "");
    if (!token || !code) return reply.status(400).send({ ok: false, code: "missing" });
    const r = await verifyTrackingOtp(token, code);
    return reply.send(r);
  });

  // ── Dispatcher: mint / revoke a tracking link for an order ──────────────────
  app.post("/delivery/orders/:id/tracking-link", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    const r = await mintTrackingLink(user.tenantId, String(req.params.id), Number(req.body?.ttlHours) || 72, user.sub);
    if (!r.ok) return reply.status(404).send(r);
    // Return the raw token once; the caller builds the customer link.
    return reply.send({ ok: true, token: r.token, path: `/track/${r.token}` });
  });

  app.post("/delivery/orders/:id/tracking-link/revoke", async (req: any, reply: any) => {
    const user = await requireDeliveryDispatch(req, reply);
    if (!user) return;
    return reply.send(await revokeTrackingLinks(user.tenantId, String(req.params.id), user.sub));
  });
}
