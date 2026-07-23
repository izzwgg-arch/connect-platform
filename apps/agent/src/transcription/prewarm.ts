/**
 * Fixed English reply templates that get pre-translated to Yiddish once and
 * pinned in the cache, so these common replies are served INSTANTLY (0ms, no YL
 * call). Add to this list as common phrasings emerge; the cache also fills
 * itself for any repeated phrase automatically.
 */

/** Shown instantly (from cache) the moment a Yiddish message arrives, while the
 *  real answer translates in the background. Keep it short + generic. */
export const INSTANT_ACK_EN = "One moment — I'm looking into that for you.";

export const PREWARM_EN: string[] = [
  INSTANT_ACK_EN,
  // Engine fixed replies (must match engine.ts wording).
  "I've received your message and passed it to our team — someone will follow up with you shortly.",
  "The support assistant is currently paused. Your message has been recorded and passed to the team.",
  "We've received a lot of requests from your account today. Please try again later or contact us directly.",
  // Common conversational openers / closers.
  "Hello! How can I help you with your phone system today?",
  "Good morning! How can I help you today?",
  "Thanks — I've passed the full details to our team for further handling.",
  "Is there anything else I can help you with?",
  "You're welcome! Have a good day.",
  "Could you tell me the extension number that's affected?",
  "Thank you. I've noted that and our team will follow up.",
];

/** Common Yiddish openers pre-translated to English so the INPUT leg is instant. */
export const PREWARM_YI: string[] = [
  "גוט מארגן",
  "א גוטן",
  "שלום עליכם",
  "א דאנק",
  "א גרויסן דאנק",
  "העלף מיר ביטע",
];
