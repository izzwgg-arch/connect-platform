/**
 * 10DLC texting registration — the carrier wording Loopcom writes FOR the
 * customer, and the checks run before anything is filed (2026-09-16).
 *
 * Izzy, 2026-09-16: "The legal stuff, the opt-in, opt-out, all that, the system
 * should already fill that in automatically" … "they could see it, just not
 * edit it, only the information that we need from them."
 *
 * So every string a carrier reviewer reads is GENERATED here from facts the
 * account already has (the name customers see, the business phone and email)
 * plus the legal name the customer types. The customer sees it read-only;
 * platform staff may edit it on the review screen before filing.
 *
 * The rules encoded here are Telnyx's published campaign rejection causes
 * (support 16256133 compliance guide, 10645583 privacy policy, 7127078 best
 * practices — researched 2026-09-16, see
 * docs/ai-context/AGENT_HANDOFF_TELNYX_10DLC_2026-09-16.md §00/§2):
 *   • every sample names the business and carries opt-out wording
 *   • the opt-in flow states frequency, rates, HELP and STOP, and that consent
 *     is optional
 *   • HELP reply names the business and a way to reach it; STOP reply
 *     confirms no more messages
 *   • the privacy policy is the BUSINESS's own (in its legal name), says mobile
 *     information is not sold OR shared, and does not mention marketing on a
 *     non-marketing campaign
 *   • description 40–4096, message flow 40–2048, replies 20–320
 *
 * ⛔ Pure module: no database, no network, no clock. Everything is testable
 * and every generated string is deterministic for the same input.
 * ⛔ No carrier name appears in anything the customer can see.
 * ⛔ Marketing and the monthly fee are deliberately absent (Izzy: "don't say
 * anything about that") — every registration is the conversational program.
 */

export interface BusinessFacts {
  /** The name customers know the business by, e.g. "Hudson Valley Tire Co.". */
  displayName: string;
  /** Legal name exactly as on the IRS letter; may be blank before the customer types it. */
  legalName?: string | null;
  /** 10 digits or E.164; shown in the HELP reply and opt-in flow. */
  businessPhone: string;
  businessEmail: string;
  /** Public page URLs for the generated privacy policy and SMS terms. */
  privacyUrl: string;
  termsUrl: string;
}

export interface CampaignContent {
  description: string;
  messageFlow: string;
  sample1: string;
  sample2: string;
  helpMessage: string;
  optoutMessage: string;
  optinMessage: string;
  helpKeywords: string;
  optoutKeywords: string;
  optinKeywords: string;
}

export const LIMITS = {
  description: { min: 40, max: 4096 },
  messageFlow: { min: 40, max: 2048 },
  reply: { min: 20, max: 320 },
  keywords: { max: 255 },
  displayName: { max: 100 },
  sample: { min: 20, max: 1024 },
} as const;

export const HELP_KEYWORDS = "HELP,INFO";
export const OPTOUT_KEYWORDS = "STOP,END,CANCEL,UNSUBSCRIBE,QUIT";
export const OPTIN_KEYWORDS = "START,YES,UNSTOP";

/** "(845) 555-0142" from any 10/11-digit US input; the input unchanged otherwise. */
export function formatUsPhone(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return String(raw || "").trim();
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** Collapse whitespace; the registry rejects stray newlines in names. */
export function cleanName(raw: string | null | undefined): string {
  return String(raw || "").replace(/\s+/g, " ").trim();
}

/** The name the wording speaks as: the name customers see, else the legal name. */
export function speakingName(f: BusinessFacts): string {
  return cleanName(f.displayName) || cleanName(f.legalName) || "the business";
}

export function buildCampaignContent(f: BusinessFacts): CampaignContent {
  const name = speakingName(f).slice(0, LIMITS.displayName.max);
  const phone = formatUsPhone(f.businessPhone);
  const email = String(f.businessEmail || "").trim();
  const reach = [phone ? `call ${phone}` : "", email ? `email ${email}` : ""].filter(Boolean).join(" or ");

  const description =
    `${name} uses text messaging to reply to customers who contact the business, and to send those ` +
    `customers updates about their requests, orders and appointments.`;

  const agreement =
    `By providing your mobile number you agree to receive text messages from ${name} about your requests, ` +
    `orders and appointments. Message frequency varies. Message and data rates may apply. ` +
    `Reply HELP for help, STOP to opt out.`;

  const messageFlow =
    `Customers opt in by texting ${name} first${phone ? ` at ${phone}` : ""}, or by giving their mobile number to ` +
    `${name} in person, by phone or on a service form and agreeing to receive text messages. The agreement ` +
    `states: "${agreement}" Consent is optional and is never a condition of purchase. ` +
    `Privacy policy: ${f.privacyUrl} Terms: ${f.termsUrl}`;

  return {
    description,
    messageFlow,
    sample1: `${name}: thanks for reaching out. We got your message and will reply shortly. Reply STOP to opt out.`,
    sample2: `${name}: your appointment is confirmed for Tuesday at 10:00 AM. Reply here with any questions. Reply STOP to opt out.`,
    helpMessage: `${name}: for help${reach ? ` ${reach}` : " reply to this message"}. Reply STOP to opt out.`,
    optoutMessage: `${name}: you are unsubscribed and will not receive more messages. Reply START to resubscribe.`,
    optinMessage:
      `${name}: you are subscribed to messages about your requests, orders and appointments. Message frequency ` +
      `varies. Message and data rates may apply. Reply HELP for help, STOP to opt out.`,
    helpKeywords: HELP_KEYWORDS,
    optoutKeywords: OPTOUT_KEYWORDS,
    optinKeywords: OPTIN_KEYWORDS,
  };
}

// ── The business's own privacy policy and SMS terms ────────────────────────

export interface PolicyDocument {
  title: string;
  paragraphs: string[];
}

/**
 * Written in the business's LEGAL name (Telnyx: the policy must be the
 * brand's own, never the reseller's). ⛔ Never mentions marketing — a
 * marketing clause on a conversational campaign is itself a rejection cause.
 */
export function buildPrivacyPolicy(f: BusinessFacts): PolicyDocument {
  const legal = cleanName(f.legalName) || speakingName(f);
  const known = speakingName(f);
  const aka = known && known !== legal ? ` ("${known}")` : "";
  const phone = formatUsPhone(f.businessPhone);
  const email = String(f.businessEmail || "").trim();
  return {
    title: `${legal} — Text Messaging Privacy Policy`,
    paragraphs: [
      `This policy explains how ${legal}${aka} handles information collected when you exchange text messages with us.`,
      `We collect your mobile phone number and the content of the messages you send us, only to reply to you and to send you updates about your requests, orders and appointments.`,
      `No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. All of the above categories exclude text messaging originator opt-in data and consent; this information will not be sold or shared with any third parties.`,
      `You can stop receiving text messages at any time by replying STOP. Reply HELP for help. Message frequency varies. Message and data rates may apply.`,
      `Questions about this policy: ${[phone, email].filter(Boolean).join(" · ") || "reply to any of our messages"}.`,
    ],
  };
}

export function buildSmsTerms(f: BusinessFacts): PolicyDocument {
  const legal = cleanName(f.legalName) || speakingName(f);
  const known = speakingName(f);
  const phone = formatUsPhone(f.businessPhone);
  const email = String(f.businessEmail || "").trim();
  return {
    title: `${legal} — Text Messaging Terms`,
    paragraphs: [
      `Program: ${known} sends text messages to customers who contact the business or ask to receive updates about their requests, orders and appointments.`,
      `Agreeing to receive text messages is optional and is not a condition of any purchase.`,
      `Message frequency varies. Message and data rates may apply.`,
      `To stop receiving messages, reply STOP at any time. You will receive one confirmation message and no further messages. To start again, reply START.`,
      `For help, reply HELP${phone || email ? `, or contact us at ${[phone, email].filter(Boolean).join(" · ")}` : ""}.`,
      `Carriers are not liable for delayed or undelivered messages.`,
      `Your information is handled as described in our Text Messaging Privacy Policy: ${f.privacyUrl}`,
    ],
  };
}

// ── Checks run before filing ────────────────────────────────────────────────

export type CheckLevel = "pass" | "warn" | "fail";
export interface Check {
  id: string;
  level: CheckLevel;
  message: string;
}

export interface CustomerAnswers {
  legalName: string;
  entityType: string;
  ein: string | null;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  website: string;
}

export const ENTITY_TYPES = ["PRIVATE_PROFIT", "PUBLIC_PROFIT", "NON_PROFIT", "GOVERNMENT", "SOLE_PROPRIETOR"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
);

/** 9 digits, with or without the dash. Never echoes the value. */
export function normalizeEin(raw: string | null | undefined): string | null {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length === 9 ? d : null;
}

const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb)\b/i;
const CORP_WORDS = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|co\.?op)\b/i;

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || "").trim());
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** Field-level problems in what the CUSTOMER typed, keyed by field — the form shows these under each box. */
export function validateCustomerAnswers(a: Partial<CustomerAnswers>, opts: { einRequired: boolean }): Record<string, string> {
  const errors: Record<string, string> = {};
  const legal = cleanName(a.legalName);
  const entity = String(a.entityType || "");
  if (legal.length < 2) errors.legalName = "Enter your legal business name exactly as it appears on your IRS letter.";
  else if (legal.length > 100) errors.legalName = "The legal name can be at most 100 characters.";
  if (!(ENTITY_TYPES as readonly string[]).includes(entity)) errors.entityType = "Choose your business type.";
  if (entity === "SOLE_PROPRIETOR") {
    if (legal && CORP_WORDS.test(legal)) errors.legalName = "A sole proprietor registers under a personal name, without LLC, Inc or Corp.";
  } else if (opts.einRequired && !normalizeEin(a.ein)) {
    errors.ein = "Enter all 9 digits of your EIN.";
  }
  if (cleanName(a.street).length < 3) errors.street = "Enter the street address the IRS has on file.";
  else if (PO_BOX.test(String(a.street))) errors.street = "Carriers do not accept a PO box. Use your street address.";
  if (cleanName(a.city).length < 2) errors.city = "Enter the city.";
  if (!US_STATES.has(String(a.state || "").trim().toUpperCase())) errors.state = "Choose the state.";
  if (!/^\d{5}(-\d{4})?$/.test(String(a.postalCode || "").trim())) errors.postalCode = "Enter the 5-digit ZIP code.";
  if (!isHttpUrl(a.website || "")) errors.website = "Enter your website, or the link to your Google Business or Facebook page.";
  return errors;
}

const BRAND_WORDS = (name: string) =>
  cleanName(name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "llc", "inc", "corp", "co"].includes(w));

/** True when the text names the business (its first distinctive word is enough, case-insensitive). */
export function namesBusiness(text: string, name: string): boolean {
  // The wording speaks as the name cut to the registry's 100 characters, so
  // compare against that same cut.
  const cut = cleanName(name).slice(0, LIMITS.displayName.max);
  const words = BRAND_WORDS(cut);
  if (!words.length) return true;
  const t = String(text || "").toLowerCase();
  return t.includes(cut.toLowerCase()) || t.includes(words[0].slice(0, 40));
}

const OPTOUT_WORDING = /\b(stop|unsubscribe|opt[\s-]?out)\b/i;
const LINK = /(https?:\/\/|www\.)\S+/i;
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const MARKETING = /\b(promo|promotion|promotional offers?|sale|discount|coupon|deal of the)\b/i;

/** Every check the review screen shows. `fail` blocks filing; `warn` does not. */
export function runFilingChecks(input: {
  facts: BusinessFacts;
  answers: Partial<CustomerAnswers>;
  content: CampaignContent;
  einPresent: boolean;
  numbersOnTelnyx: number;
}): Check[] {
  const { facts, answers, content } = input;
  const name = speakingName(facts);
  const out: Check[] = [];
  const add = (id: string, ok: boolean, pass: string, fail: string, level: CheckLevel = "fail") =>
    out.push({ id, level: ok ? "pass" : level, message: ok ? pass : fail });

  const entity = String(answers.entityType || "");
  const fieldErrors = validateCustomerAnswers(answers, { einRequired: false });
  add("answers", Object.keys(fieldErrors).length === 0, "The customer's business details are complete", `Business details incomplete: ${Object.values(fieldErrors).join(" ")}`);
  if (entity !== "SOLE_PROPRIETOR") {
    add("ein", input.einPresent, "EIN is on file (tokenized)", "No EIN on file. Ask the customer to enter it again.");
  }
  add("description", content.description.length >= LIMITS.description.min && content.description.length <= LIMITS.description.max,
    "Description length is within 40–4096 characters", "Description must be 40–4096 characters");
  add("messageFlow", content.messageFlow.length >= LIMITS.messageFlow.min && content.messageFlow.length <= LIMITS.messageFlow.max,
    "Opt-in description length is within 40–2048 characters", "Opt-in description must be 40–2048 characters");
  const flow = content.messageFlow.toLowerCase();
  add("optinDisclosures", ["frequency", "rates", "help", "stop"].every((w) => flow.includes(w)),
    "Opt-in explains frequency, rates, HELP and STOP", "Opt-in must mention message frequency, message and data rates, HELP and STOP");
  add("optinOptional", /optional|not a condition/i.test(content.messageFlow), "Opt-in says consent is optional", "Opt-in must say consent is optional and not a condition of purchase");
  add("privacyLinked", content.messageFlow.includes(facts.privacyUrl), "Opt-in links the business's privacy policy", "Opt-in must link the business's privacy policy");
  for (const [id, text] of [["sample1", content.sample1], ["sample2", content.sample2]] as const) {
    add(`${id}Names`, namesBusiness(text, name), `${id === "sample1" ? "Sample 1" : "Sample 2"} names the business`, `${id === "sample1" ? "Sample 1" : "Sample 2"} must name the business`);
    add(`${id}Optout`, OPTOUT_WORDING.test(text), `${id === "sample1" ? "Sample 1" : "Sample 2"} has opt-out wording`, `${id === "sample1" ? "Sample 1" : "Sample 2"} must include "Reply STOP to opt out"`);
    add(`${id}NoLink`, !LINK.test(text), `${id === "sample1" ? "Sample 1" : "Sample 2"} has no link`, `${id === "sample1" ? "Sample 1" : "Sample 2"} contains a link but the campaign declares no links. Remove it.`);
    add(`${id}NoPhone`, !PHONE.test(text), `${id === "sample1" ? "Sample 1" : "Sample 2"} has no phone number`, `${id === "sample1" ? "Sample 1" : "Sample 2"} contains a phone number but the campaign declares none. Remove it.`);
    add(`${id}NoMarketing`, !MARKETING.test(text), `${id === "sample1" ? "Sample 1" : "Sample 2"} is not promotional`, `${id === "sample1" ? "Sample 1" : "Sample 2"} reads as marketing, which this program does not cover`);
    add(`${id}Length`, text.length >= LIMITS.sample.min && text.length <= LIMITS.sample.max, `${id === "sample1" ? "Sample 1" : "Sample 2"} length is fine`, `${id === "sample1" ? "Sample 1" : "Sample 2"} must be 20–1024 characters`);
  }
  for (const [id, label, text] of [
    ["help", "HELP reply", content.helpMessage],
    ["optout", "STOP reply", content.optoutMessage],
    ["optin", "START reply", content.optinMessage],
  ] as const) {
    add(`${id}Length`, text.length >= LIMITS.reply.min && text.length <= LIMITS.reply.max, `${label} length is within 20–320 characters`, `${label} must be 20–320 characters`);
    add(`${id}Names`, namesBusiness(text, name), `${label} names the business`, `${label} must name the business`);
  }
  add("helpContact", /\d{3}.*\d{4}|@/.test(content.helpMessage), "HELP reply gives a way to reach the business", "HELP reply must include a phone number or email");
  for (const [id, kw] of [["helpKw", content.helpKeywords], ["optoutKw", content.optoutKeywords], ["optinKw", content.optinKeywords]] as const) {
    add(id, /^[A-Z0-9]+(,[A-Z0-9]+)*$/.test(kw) && kw.length <= LIMITS.keywords.max, `Keywords ${kw} are well formed`, `Keywords must be comma separated with no spaces: "${kw}"`);
  }
  add("optoutStopKw", content.optoutKeywords.split(",").includes("STOP"), "STOP stops messages", "STOP must be an opt-out keyword");
  add("numbers", input.numbersOnTelnyx > 0,
    `${input.numbersOnTelnyx} number${input.numbersOnTelnyx === 1 ? "" : "s"} can be attached when approved`,
    "No Telnyx-hosted texting number for this customer yet. The registration can still be filed; numbers attach once they move to Telnyx.", "warn");
  return out;
}

export function checksBlockFiling(checks: Check[]): boolean {
  return checks.some((c) => c.level === "fail");
}

/** A URL-safe slug for the public policy page: "hudson-valley-tire-co". */
export function slugify(raw: string): string {
  const s = cleanName(raw)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "business";
}
