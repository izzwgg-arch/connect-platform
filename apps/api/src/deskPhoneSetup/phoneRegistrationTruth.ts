/**
 * Per-PHONE registration truth.
 *
 * ⛔⛔ THE WIZARD MAY NEVER SAY A PHONE IS CONNECTED WITHOUT IT ACTUALLY BEING
 * CONNECTED (Izzy, 2026-09-17, after the live run showed both directions of the
 * lie at once: the Yealink at .170 WAS registered and the wizard didn't know,
 * while "connected" could equally have been claimed for the unregistered .171
 * because its extension was held by ANOTHER handset).
 *
 * The structural cause: `PbxEndpointRegistration` is one row per ENDPOINT, and
 * an AOR allows max_contacts=5 — two desk phones on ext 101 collapse into one
 * row, each overwriting the other. The honest unit is the CONTACT: every
 * contact-status push carries `x-ast-orig-host=<the phone's own LAN IP>`, which
 * NAT cannot rewrite and which discovery also knows for every phone in a run.
 *
 * This module is PURE — the routes hand it the phone (ip + extNumber) and the
 * tenant's contact rows, and it answers with what may honestly be claimed:
 *
 *   • A contact row matching the phone's LAN IP answers OUTRIGHT — registered
 *     or not, and as WHICH extension (a phone the wizard never touched can
 *     register through GDMS/RPS on its own; that is still truth, and shown).
 *   • The phone's extension registered FROM A DIFFERENT IP is NOT this phone —
 *     that claim is refused (the .171 lie).
 *   • No contact data at all (cold mirror right after deploy) falls back to the
 *     old extension-level answer, EXPLICITLY marked extension-level by the
 *     caller keeping its own `isRegistered` — never presented as per-phone proof.
 */

export type PhoneContactReg = {
  endpoint: string;
  origIp: string;
  extNumber: string | null;
  isWebrtcDevice: boolean;
  status: string;
  lastEventAt: Date | string;
};

export type PhoneRegTruth =
  /** A contact row for this phone's own LAN IP decides. */
  | { kind: "device"; connected: boolean; registeredAsExt: string | null }
  /** Its extension is held by a different device — this phone is NOT connected. */
  | { kind: "extension_held_by_other_device"; connected: false }
  /** No contact rows bear on this phone — the caller may use its extension-level fallback. */
  | { kind: "unknown" };

const ORIG_HOST_RE = /x-ast-orig-host=((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?::\d+)?/i;

/** The device's own LAN IPv4 out of a pjsip contact URI, or null. */
export function origIpOf(contactUri: string | null | undefined): string | null {
  if (!contactUri) return null;
  const m = ORIG_HOST_RE.exec(contactUri);
  return m ? m[1] : null;
}

/**
 * What may honestly be claimed about ONE phone, from the tenant's contact rows.
 * `ip` is where our own scan saw the handset; `extNumber` is the wizard's mapping.
 */
export function phoneRegistrationTruth(
  phone: { ip: string | null; extNumber: string | null },
  contacts: PhoneContactReg[],
): PhoneRegTruth {
  const desk = contacts.filter((c) => !c.isWebrtcDevice);
  // 1) This phone's own address answers outright, newest event first.
  if (phone.ip) {
    const mine = desk
      .filter((c) => c.origIp === phone.ip)
      .sort((a, b) => new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime());
    if (mine.length) {
      const current = mine.find((c) => c.status === "REGISTERED") ?? mine[0];
      return {
        kind: "device",
        connected: current.status === "REGISTERED",
        registeredAsExt: current.status === "REGISTERED" ? current.extNumber : null,
      };
    }
  }
  // 2) Its extension registered from a DIFFERENT known address is another device.
  if (phone.extNumber) {
    const held = desk.some(
      (c) => c.extNumber === phone.extNumber && c.status === "REGISTERED" && (!phone.ip || c.origIp !== phone.ip),
    );
    // Only a refusal when we could have recognised this phone (we know its ip) —
    // a phone with no known ip cannot be told apart from the registered one.
    if (held && phone.ip) return { kind: "extension_held_by_other_device", connected: false };
    if (held && !phone.ip) return { kind: "unknown" };
    // Contact rows exist for this extension and NONE is registered → honestly down.
    if (desk.some((c) => c.extNumber === phone.extNumber)) {
      return { kind: "device", connected: false, registeredAsExt: null };
    }
  }
  return { kind: "unknown" };
}
