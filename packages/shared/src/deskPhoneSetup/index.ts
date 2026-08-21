/**
 * Zero-touch desk phone setup — the rules, with nothing that talks to a network.
 *
 * ⛔ Everything here is a pure function. The reason is that these decisions —
 * may this phone be wiped, which colleague gets which button, what is the customer
 * told — are the ones that must be testable without a phone, a PBX or a customer.
 */
export * from "./standards";
export * from "./buttonLayout";
export * from "./states";
export * from "./deviceIdentity";
export * from "./escalation";
