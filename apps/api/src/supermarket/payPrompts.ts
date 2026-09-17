/**
 * The pay line's prompt manifest — every recorded file the reducer can name,
 * with the words it says. New files are cut from THIS list
 * (apps/api/scripts/cut-pay-prompts.ts) in the line's own voice: Amazon Polly,
 * voice "Stephen", engine "neural" — Izzy's pick B on 2026-08-25, and
 * "Stephen = neural, always" (a generative/neural mix in one set was audible
 * and rejected). "Gesheft" is voiced through the IPA phoneme the original set
 * used, so the store's name sounds the same in every file.
 *
 * ⛔ The reducer never renders text at call time: these strings exist so the
 * recordings and the state machine cannot drift apart. Files 01–22 were cut on
 * 2026-08-25/26 and their scripts were never committed — the `text` for those
 * is a paraphrase from the handoffs; the RECORDINGS are the authority for
 * them. Files with `addedOn` are cut from the text here, verbatim.
 * Numbers (num_0 … num_thousand) are spliced by payAmount.ts; not listed here.
 *
 * History: files 23–35 (the one-time code by call/text and the "own account
 * unservable" redirect) were cut on 2026-09-17 and retired the same evening
 * when Izzy replaced that flow with "your account or a different one → PIN".
 * The WAVs stay on the PBX (harmless); the reducer no longer names them.
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
  /** Files cut from this manifest (the cutter cuts exactly these). */
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
  // ── 2026-09-17 evening (final flow) ───────────────────────────────────────
  {
    ref: "36_no_pin_visit_store",
    text: "This account does not have a PIN set up yet. To pay by phone, please visit the store to set one up.",
    addedOn: "2026-09-17",
  },
  {
    ref: "37_which_account",
    text: "To make a payment or hear a balance on the account for the number you are calling from, press one. For a different account, press two.",
    addedOn: "2026-09-17",
  },
  {
    ref: "38_enter_phone",
    text: "Please enter the phone number on the account, followed by the pound key.",
    addedOn: "2026-09-17",
  },
  // ── 2026-09-17 night: pay with a keyed card (Izzy: "give them the option to pay with
  // another card, even if there isn't a card on file … one-time or add it to the account") ──
  {
    ref: "39_confirm_choice_card",
    text: "To confirm, press one. To enter a different amount, press two. To pay with a different card, press three.",
    addedOn: "2026-09-17",
  },
  { ref: "40_card_offer", text: "To pay with a card now, press one. To speak with someone, press two.", addedOn: "2026-09-17" },
  { ref: "41_card_number", text: "Please enter the card number, followed by the pound key.", addedOn: "2026-09-17" },
  {
    ref: "42_card_exp",
    text: "Enter the expiration date as four digits, two for the month and two for the year, followed by the pound key.",
    addedOn: "2026-09-17",
  },
  { ref: "43_card_cvv", text: "Enter the security code on the back of the card, followed by the pound key.", addedOn: "2026-09-17" },
  { ref: "44_card_zip", text: "Enter the billing zip code, followed by the pound key.", addedOn: "2026-09-17" },
  { ref: "45_card_invalid", text: "That does not look right. Let's try again.", addedOn: "2026-09-17" },
  {
    ref: "46_card_save_choice",
    text: "To use this card for this payment only, press one. To save it to your account as the card on file, press two.",
    addedOn: "2026-09-17",
  },
  { ref: "47_card_declined_offer", text: "To try a different card, press one. To speak with someone, press two.", addedOn: "2026-09-17" },
];

export const PAY_PROMPTS_ADDED_2026_09_17: readonly PayPromptSpec[] = PAY_PROMPTS.filter((p) => p.addedOn === "2026-09-17");

/** Every ref the reducer may name that is not a number file. */
export function payPromptRefs(): string[] {
  return PAY_PROMPTS.map((p) => p.ref);
}
