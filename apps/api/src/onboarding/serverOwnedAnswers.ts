/**
 * Keys inside `answers` that the SERVER writes and the wizard never sends back.
 *
 * ⛔ Found by the Telnyx end-to-end run, 2026-09-16: the wizard's autosave
 * REPLACES `answers` wholesale, and its form state has no idea the server
 * stamped `phone.provider` at apply-number time. The very next autosave wiped
 * the stamp, so at payment `applyOnboardingNumber` fell back to "voipms" and
 * would have tried to buy a Telnyx-searched number from VoIP.ms. The same
 * wipe hit every server-written key: the provisioning identity/state and the
 * texting-registration summary. (Pre-existing — SignalWire sign-ups had it too.)
 *
 * The client's copy never wins for these keys: the stored value is carried
 * through every replace. `linkKind` is handled beside this by the save route.
 */
export function carryServerOwnedAnswers(stored: unknown, incoming: unknown): unknown {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const prev: any = stored && typeof stored === "object" ? stored : {};
  const next: any = { ...(incoming as any) };
  const provider = prev?.phone?.provider;
  if (provider) {
    next.phone = { ...(next.phone && typeof next.phone === "object" ? next.phone : {}), provider };
  }
  if (prev.provisioning !== undefined) next.provisioning = prev.provisioning;
  // ⛔ Admin-set pricing (cold calling / CRM). ALWAYS the stored value — a
  // client-sent `pricing` is dropped even when nothing is stored, so a customer
  // can never set or clear their own price.
  if (prev.pricing !== undefined) next.pricing = prev.pricing;
  else delete next.pricing;
  return next;
}
