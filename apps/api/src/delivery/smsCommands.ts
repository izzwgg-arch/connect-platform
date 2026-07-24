// Inbound SMS command parser — PURE. Tolerant intent recognition over a FINITE, documented
// command set (no open-ended chatbot). Maps natural phrasing + keywords to a delivery intent.
//
// Compliance: STOP/START are recognized first and always honored (carrier requirement).

export type SmsIntent = "status" | "track" | "eta" | "help" | "stop" | "start" | "order" | "unknown";

export interface ParsedSms {
  intent: SmsIntent;
  /** For ORDER <#> or a bare order number. */
  orderNumber?: string;
}

const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out"];
const START_WORDS = ["start", "unstop", "yes", "optin", "opt-in", "subscribe"];

export function parseSmsCommand(raw: string): ParsedSms {
  const text = String(raw || "").trim();
  if (!text) return { intent: "unknown" };
  const lower = text.toLowerCase();
  const firstWord = lower.split(/\s+/)[0];

  // Compliance keywords take precedence (exact first-word match).
  if (STOP_WORDS.includes(firstWord)) return { intent: "stop" };
  if (START_WORDS.includes(firstWord)) return { intent: "start" };

  // Explicit ORDER <number> — the token must contain at least one digit (order numbers do),
  // so "order arrives" / "order status" are NOT treated as an order-number lookup.
  const orderMatch = lower.match(/\border\s*#?\s*([a-z0-9-]*\d[a-z0-9-]*)/i);
  if (orderMatch) return { intent: "order", orderNumber: orderMatch[1].toUpperCase() };

  // Bare order-number-looking token (digits, 3+), when the whole message is basically that.
  if (/^#?\d{3,}$/.test(text)) return { intent: "order", orderNumber: text.replace(/^#/, "") };

  if (firstWord === "help" || lower.includes("help")) return { intent: "help" };
  if (firstWord === "track" || lower.includes("track") || lower.includes("link")) return { intent: "track" };
  if (firstWord === "eta" || lower.includes("eta") || lower.includes("how long") || lower.includes("how much longer")) return { intent: "eta" };
  if (firstWord === "status" || lower.includes("status")) return { intent: "status" };

  // Tolerant natural phrasing → status
  if ((lower.includes("where") && (lower.includes("order") || lower.includes("delivery") || lower.includes("driver")))
    || lower.includes("wheres my") || lower.includes("where's my")) {
    return { intent: "status" };
  }
  if (lower === "delivery" || lower === "order") return { intent: "status" };

  return { intent: "unknown" };
}

/** The documented command set, for HELP responses. */
export const SMS_COMMANDS = ["STATUS", "TRACK", "ETA", "ORDER <number>", "HELP", "STOP", "START"] as const;
