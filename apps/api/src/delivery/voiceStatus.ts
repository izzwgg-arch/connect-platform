// Voice status response builder — PURE. Composes an IVR response from PRERECORDED prompt
// fragments + number/digit playback (decision 2: no TTS). Never speaks sensitive data
// (address/payment/instructions). Tiered detail is inherent — only status + ETA are voiced.
//
// This produces a fragment PLAN. The PBX dialplan overlay (connect-tenant-ivr) plays it via
// Background()/SayNumber. This module writes NOTHING to the PBX.

export type VoiceFragment =
  | { type: "prompt"; ref: string; text: string } // prerecorded audio; text = transcript (review/tests)
  | { type: "sayNumber"; value: number; text: string }
  | { type: "sayMinuteRange"; from: number; to: number; text: string }
  | { type: "menu"; ref: string; text: string; options: { digit: string; action: string }[] }
  | { type: "collectDigits"; ref: string; text: string; maxDigits: number; onTimeout: string }
  | { type: "transfer"; text: string }
  | { type: "hangup"; text: string };

export type VoiceScenario =
  | "matched_single"
  | "matched_multiple"
  | "unmatched"
  | "no_order"
  | "delivered"
  | "delayed"
  | "canceled"
  | "after_hours"
  | "system_error";

export interface VoiceContext {
  statusLabel?: string; // customer-safe label (from publicStatus)
  active?: boolean; // en route / arriving
  etaMinFrom?: number | null; // minutes
  etaMinTo?: number | null;
  orderCount?: number;
}

const MAIN_MENU = {
  type: "menu" as const,
  ref: "delivery/menu_main",
  text: "Press 1 to receive a tracking link by text. Press 2 to hear this again. Press 0 for the store.",
  options: [
    { digit: "1", action: "text_link" },
    { digit: "2", action: "repeat" },
    { digit: "0", action: "transfer_store" },
  ],
};

/** Round minutes to the nearest 5 for natural number playback. */
export function roundMinutes(m: number): number {
  return Math.max(0, Math.round(m / 5) * 5);
}

function etaFragment(ctx: VoiceContext): VoiceFragment | null {
  if (!ctx.active || ctx.etaMinFrom == null || ctx.etaMinTo == null) return null;
  const from = roundMinutes(ctx.etaMinFrom);
  const to = roundMinutes(ctx.etaMinTo);
  return { type: "sayMinuteRange", from, to, text: `Your driver is approximately ${from} to ${to} minutes away.` };
}

/** Build the ordered fragment plan for a scenario. Pure. */
export function buildVoiceResponse(scenario: VoiceScenario, ctx: VoiceContext = {}): VoiceFragment[] {
  const out: VoiceFragment[] = [];
  const push = (f: VoiceFragment | null) => { if (f) out.push(f); };

  switch (scenario) {
    case "matched_single":
      push({ type: "prompt", ref: "delivery/found_one", text: "We found one active delivery for this phone number." });
      push({ type: "prompt", ref: "delivery/status", text: `Your order is ${ctx.statusLabel || "in progress"}.` });
      push(etaFragment(ctx));
      push(MAIN_MENU);
      break;
    case "matched_multiple":
      push({ type: "prompt", ref: "delivery/found_multiple", text: `You have ${ctx.orderCount ?? "multiple"} active deliveries.` });
      push({ type: "collectDigits", ref: "delivery/enter_last4", text: "Enter the last four digits of your order number.", maxDigits: 4, onTimeout: "transfer_store" });
      break;
    case "unmatched":
      push({ type: "prompt", ref: "delivery/no_match_number", text: "I couldn't find an order for this number." });
      push({ type: "collectDigits", ref: "delivery/enter_phone", text: "Enter the 10-digit phone number on your order, or press 1 for your order number.", maxDigits: 10, onTimeout: "transfer_store" });
      break;
    case "no_order":
      push({ type: "prompt", ref: "delivery/no_active_order", text: "I couldn't find an active order." });
      push({ type: "menu", ref: "delivery/menu_nomatch", text: "Press 1 to try again, 2 to enter an order number, or 0 for the store.", options: [
        { digit: "1", action: "retry" }, { digit: "2", action: "enter_order" }, { digit: "0", action: "transfer_store" },
      ] });
      break;
    case "delivered":
      push({ type: "prompt", ref: "delivery/delivered", text: "Your order was delivered." });
      push({ type: "menu", ref: "delivery/menu_delivered", text: "Press 1 to receive a receipt by text, or 0 for the store.", options: [
        { digit: "1", action: "text_link" }, { digit: "0", action: "transfer_store" },
      ] });
      break;
    case "delayed":
      push({ type: "prompt", ref: "delivery/delayed", text: "Your order is delayed." });
      push(etaFragment(ctx) || { type: "prompt", ref: "delivery/revised_soon", text: "A revised estimate will be available shortly." });
      push(MAIN_MENU);
      break;
    case "canceled":
      push({ type: "prompt", ref: "delivery/canceled", text: "This order has been canceled." });
      push({ type: "menu", ref: "delivery/menu_store", text: "Press 0 for the store.", options: [{ digit: "0", action: "transfer_store" }] });
      break;
    case "after_hours":
      push({ type: "prompt", ref: "delivery/after_hours", text: "Our store is closed, but I can still check your delivery." });
      push({ type: "prompt", ref: "delivery/status", text: `Your order is ${ctx.statusLabel || "in progress"}.` });
      push(etaFragment(ctx));
      push({ type: "menu", ref: "delivery/menu_afterhours", text: "Press 1 for a tracking link by text, or 2 to leave a callback.", options: [
        { digit: "1", action: "text_link" }, { digit: "2", action: "callback" },
      ] });
      break;
    case "system_error":
      // Fail safe — never expose the error; offer only safe options.
      push({ type: "prompt", ref: "delivery/system_error", text: "I'm having trouble checking that right now." });
      push({ type: "menu", ref: "delivery/menu_error", text: "Press 1 to receive a tracking link by text, or 0 for the store.", options: [
        { digit: "1", action: "text_link" }, { digit: "0", action: "transfer_store" },
      ] });
      break;
  }
  return out;
}
