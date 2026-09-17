/**
 * The pay line's prompt manifest — every recorded file the reducer can name,
 * with the words it says. The 09-17 one-time-code additions (23–33) are cut
 * from THIS list (apps/api/scripts/cut-pay-prompts.ts) in the line's own
 * voice: Amazon Polly, voice "Stephen", engine "neural" — Izzy's pick B on
 * 2026-08-25, and "Stephen = neural, always" (a generative/neural mix in one
 * set was audible and rejected). "Gesheft" is voiced through the IPA phoneme
 * the original set used, so the store's name sounds the same in every file.
 *
 * ⛔ The reducer never renders text at call time: these strings exist so the
 * recordings and the state machine cannot drift apart. Files 01–22 were cut on
 * 2026-08-25/26 and their scripts were never committed — the `text` for those
 * is a paraphrase from the handoffs; the RECORDINGS are the authority for
 * them. Files 23–33 (addedOn 2026-09-17) are cut from the text here, verbatim.
 * Numbers (num_0 … num_thousand) are read digit by digit or spliced by
 * payAmount.ts; they are not listed here.
 */

export const PAY_POLLY_VOICE_ID = "Stephen";
export const PAY_POLLY_ENGINE = "neural" as const;

/** Izzy's pick B (2026-08-25): hard G, "guh-SHEFT". */
export const GESHEFT_SSML = `<phoneme alphabet="ipa" ph="ɡəˈʃɛft">Gesheft</phoneme>`;

export type PayPromptSpec = {
  ref: string;
  /** Plain words, for the record and for tests. */
  text: string;
  /** SSML body when the plain text is not enough (pronunciation); wrapped in <speak> by the cutter. */
  ssml?: string;
  /** Files added 2026-09-17 for the one-time code flow. */
  addedOn?: "2026-09-17";
};

export const PAY_PROMPTS: readonly PayPromptSpec[] = [
  { ref: "01_welcome", text: "Welcome to the Gesheft payment line." },
  { ref: "02_pin", text: "Please enter your PIN, followed by the pound key." },
  { ref: "03_pin_wrong", text: "That PIN is not correct." },
  { ref: "04_balance_intro", text: "Your current balance is" },
  { ref: "05_amount_prompt", text: "Enter the amount you would like to pay, using the star key as the decimal point, followed by the pound key." },
  { ref: "06_confirm_intro", text: "You entered" },
  { ref: "07_confirm_choice", text: "To confirm, press one. To enter a different amount, press two." },
  { ref: "08_processing", text: "Please hold while we process your payment." },
  { ref: "09_approved_intro", text: "Your payment was approved. Your new balance is" },
  { ref: "10_thanks_bye", text: "Thank you. Goodbye." },
  { ref: "11_declined", text: "The card on file was declined." },
  { ref: "12_no_card", text: "There is no card on file for this account." },
  { ref: "13_not_recognized", text: "We do not recognize the number you are calling from. Please enter the phone number on your account, followed by the pound key." },
  { ref: "14_invalid_amount", text: "That amount is not valid." },
  { ref: "15_too_many_tries", text: "Too many tries." },
  { ref: "16_dollars", text: "dollars" },
  { ref: "17_cents", text: "cents" },
  { ref: "18_and", text: "and" },
  { ref: "19_lookup_not_found", text: "We could not find an account with that phone number." },
  { ref: "20_connect_person", text: "Please hold while we connect you to someone who can help." },
  { ref: "21_menu_after_balance", text: "To make a payment, press two. To hear your balance again, press one." },
  { ref: "22_main_menu", text: "To hear your balance, press one. To make a payment, press two." },
  // ── 2026-09-17: the one-time code flow ─────────────────────────────────────
  {
    ref: "23_pin_or_star",
    text: "Please enter your PIN, followed by the pound key. If you do not have a PIN, press star.",
    addedOn: "2026-09-17",
  },
  {
    ref: "24_code_channel_menu",
    text: "We can send you a one-time code to verify your account. To receive the code by phone call, press one. To receive it by text message, press two.",
    addedOn: "2026-09-17",
  },
  { ref: "25_code_number_intro", text: "Which number on your account should receive the code?", addedOn: "2026-09-17" },
  { ref: "26_press", text: "Press", addedOn: "2026-09-17" },
  { ref: "27_for_number_ending_in", text: "for the number ending in", addedOn: "2026-09-17" },
  {
    ref: "28_code_call_intro",
    text: "Hello. This is Gesheft. Your one-time phone payment code is",
    ssml: `Hello. This is ${GESHEFT_SSML}. Your one-time phone payment code is`,
    addedOn: "2026-09-17",
  },
  { ref: "29_code_again", text: "Once again, your code is", addedOn: "2026-09-17" },
  { ref: "30_enter_code", text: "Please enter the six digit code, followed by the pound key.", addedOn: "2026-09-17" },
  {
    ref: "31_code_call_sent",
    text: "We are calling you now with your code. When you have it, enter the six digits, followed by the pound key.",
    addedOn: "2026-09-17",
  },
  {
    ref: "32_code_text_sent",
    text: "We sent your code by text message. Enter the six digits, followed by the pound key.",
    addedOn: "2026-09-17",
  },
  { ref: "33_code_wrong", text: "That code is not correct.", addedOn: "2026-09-17" },
];

export const PAY_PROMPTS_ADDED_2026_09_17: readonly PayPromptSpec[] = PAY_PROMPTS.filter((p) => p.addedOn === "2026-09-17");

/** Every ref the reducer may name that is not a number file. */
export function payPromptRefs(): string[] {
  return PAY_PROMPTS.map((p) => p.ref);
}
