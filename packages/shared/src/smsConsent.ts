// Exact 10DLC SMS opt-in consent language declared in our campaign registration.
// This MUST stay identical to the marketing site (connect-website lib/sms-consent.ts)
// and to the carrier campaign registration. Do not edit wording without updating both.
export const SMS_CONSENT_LABEL =
  "I agree to receive service-related text messages (account notifications, customer support, verification codes, security alerts) from Connect Communications. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.";

// Version stamp recorded with each consent record so the exact wording a user
// agreed to can be reconstructed during a carrier audit.
export const SMS_CONSENT_VERSION = "2026-07-15";

export type SmsConsentMethod = "signup_form" | "dashboard_settings";
