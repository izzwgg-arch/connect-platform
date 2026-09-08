/**
 * Every customer-facing string on the Security screen, byte-exact, so Yiddish
 * can be warmed for it (CLAUDE.md: register a PHRASES list + useUiLanguage).
 * Kept out of page.tsx because a page may only export its default component.
 *
 * v3 (2026-09-08): the authenticator-app strings are gone — two-step
 * verification is a code by text message or email, and nothing else.
 */
export const SECURITY_PHRASES = [
  "Security",
  "Two-step verification protects your account with a code as well as your password.",
  "Two-step verification",
  "On",
  "Off",
  "Loading…",
  "Your role requires two-step verification. Set it up now — it takes about a minute.",
  "Not now",
  "Turn on two-step verification",
  "Turn off",
  "Turned on",
  "codes by text message or email",
  "Each time you sign in we send a 6-digit code to your registered mobile number or email. You choose which at sign-in.",
  "Where your codes go",
  "Text message",
  "Email",
  "your registered mobile number",
  "your account email",
  "No mobile number on file, so codes go by email. Ask your administrator to add your mobile number to get texts.",
  "To change the mobile number, ask your administrator. The code is asked once each time you sign in and stays until you sign out.",
  "The Loopcom phone app cannot ask for the code yet. If you sign in on the app, wait before turning this on.",
  "Two-step verification is on. Each time you sign in we’ll ask for a code by text or email.",
  "Two-step verification is off. Your password alone signs you in.",
  "Enter your password to turn two-step verification off. Your password alone will sign you in.",
  "Password",
  "Cancel",
  "Enter your password.",
  "This account uses an authenticator app for two-step verification. To switch to a code by text or email, ask your administrator to reset it.",
];
