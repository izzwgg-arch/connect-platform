"use client";

/**
 * The business-texting registration step — built exactly to the approved
 * 2026-08-30 mockups (screen C + mobile frames 7/7b).
 *
 * Carriers require every business that texts to be registered (10DLC). This
 * card collects the registration INSIDE the wizard: identity fields, the
 * two-tier fork (conversations vs promotions/automated), the hosted-vs-own
 * sender fork with the carriers' own sample-message questions, the collapsible
 * "Why do we ask for this?", pricing, and the consent line.
 *
 * ⛔⛔ THE EIN IS NEVER PART OF THE AUTOSAVED FORM. It lives in its own state
 * in the page and is passed here as a plain controlled prop — on Continue it
 * travels ONCE to POST /onboarding/:token/texting-registration, which forwards
 * it inside SignalWire's create-brand call and never writes it anywhere
 * (see apps/api/src/signalwire/signalWireTenDlc.ts). The lock note on screen
 * is that promise in writing; keeping the EIN out of the draft is what makes
 * the sentence true. Never move `ein` into FormData / the autosave payload.
 */

import { ConnectSelect } from "../../../components/ConnectSelect";

export type TextingClassification = "" | "conversational" | "marketing";

export type TextingState = {
  classification: TextingClassification;
  /** Who sends the automated messages (marketing only). */
  senderSystem: "" | "loopcom" | "own";
  legalName: string;
  entityType: "" | "PRIVATE_PROFIT" | "PUBLIC_PROFIT" | "NON_PROFIT" | "GOVERNMENT";
  website: string;
  vertical: string;
  /** Own-system marketing: the carriers' own required questions. */
  messageFlow: string;
  sample1: string;
  sample2: string;
  volume: string;
  /** "I don't have an EIN" — the sole-proprietor path (limited class). */
  noEin: boolean;
};

export const EMPTY_TEXTING: TextingState = {
  classification: "",
  senderSystem: "",
  legalName: "",
  entityType: "",
  website: "",
  vertical: "",
  messageFlow: "",
  sample1: "",
  sample2: "",
  volume: "",
  noEin: false,
};

export const ENTITY_OPTIONS = [
  { value: "PRIVATE_PROFIT", label: "Private company (LLC / Corp)" },
  { value: "PUBLIC_PROFIT", label: "Publicly traded company" },
  { value: "NON_PROFIT", label: "Non-profit" },
  { value: "GOVERNMENT", label: "Government" },
];

export const VERTICAL_OPTIONS = [
  "Construction & trades", "Retail & stores", "Professional services", "Healthcare",
  "Food & hospitality", "Real estate", "Automotive", "Education", "Technology",
  "Non-profit & religious", "Other",
].map((v) => ({ value: v, label: v }));

/** Two-letter codes for the number search's state filter (SignalWire `region`).
 *  Lives here (a sibling module) because a Next.js page file may only export
 *  its default component — a named export from page.tsx fails the production
 *  build with "does not match the required types of a Next.js Page". */
export const US_STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI",
  "SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

export function isEinShaped(v: string): boolean {
  return /^\d{2}-?\d{7}$/.test(v.trim());
}

/**
 * One validation rule for desktop AND mobile — the message is what the step
 * refuses with, in the customer's own words (never a slug).
 */
export function validateTexting(t: TextingState, ein: string, consent: boolean): string | null {
  if (!t.classification) return "Choose how your business will use texting.";
  if (t.legalName.trim().length < 2) return "Your legal business name is required for the carrier registration.";
  if (t.noEin) {
    // Sole-proprietor path — no EIN, limited class, filed with a person's help.
  } else {
    if (!isEinShaped(ein)) return "The EIN should be nine digits, like 82-1234567 — or choose “I don’t have an EIN.”";
    if (!t.entityType) return "Choose your business type.";
  }
  if (t.classification === "marketing") {
    if (!t.senderSystem) return "Tell us what sends your automated messages.";
    if (t.senderSystem === "own") {
      if (t.messageFlow.trim().length < 20) return "Describe what you’ll send and how people sign up — a sentence or two.";
      if (t.sample1.trim().length < 20) return "Example message 1 needs to be a real example — at least 20 characters.";
      if (t.sample2.trim().length < 20) return "Example message 2 needs to be a real example — at least 20 characters.";
    }
  }
  if (!consent) return "Please authorize the registration — carriers require your consent before we can file it.";
  return null;
}

/** The exact POST body for /onboarding/:token/texting-registration. */
export function buildTextingRegistrationPayload(t: TextingState, ein: string): Record<string, unknown> {
  const classification = t.noEin ? "sole_prop" : (t.classification === "marketing" ? "marketing" : "conversational");
  return {
    classification,
    senderSystem: t.classification === "marketing" ? (t.senderSystem || undefined) : undefined,
    legalName: t.legalName.trim(),
    entityType: t.noEin ? undefined : (t.entityType || undefined),
    // ⛔ The ONLY place the EIN leaves the browser. Never echo it back, never
    // put it in the autosave payload.
    ein: t.noEin ? undefined : ein.trim(),
    website: t.website.trim() || undefined,
    vertical: t.vertical || undefined,
    messageFlow: t.classification === "marketing" && t.senderSystem === "own" ? t.messageFlow.trim() : undefined,
    sample1: t.classification === "marketing" && t.senderSystem === "own" ? t.sample1.trim() : undefined,
    sample2: t.classification === "marketing" && t.senderSystem === "own" ? t.sample2.trim() : undefined,
    consent: true,
  };
}

function Radio({ on }: { on: boolean }) {
  return <span className={`ob-tx-radio${on ? " on" : ""}`} aria-hidden />;
}

export function TextingRegistrationCard(props: {
  texting: TextingState;
  onChange: (patch: Partial<TextingState>) => void;
  ein: string;
  onEinChange: (v: string) => void;
  consent: boolean;
  onConsentChange: (v: boolean) => void;
  theme: "dark" | "light";
  serviceAddress: string;
  /** Mobile renders the identity half on its own screen. */
  section?: "all" | "identity" | "usage";
}) {
  const { texting: t, onChange, ein, onEinChange, consent, onConsentChange, theme, serviceAddress } = props;
  const section = props.section ?? "all";
  const showIdentity = section !== "usage";
  const showUsage = section !== "identity";

  return (
    <div className="ob-tx-card">
      <div className="ob-tx-head">One-time carrier registration <span>(required by U.S. carriers)</span></div>
      <p className="ob-tx-lead">
        Federal anti-spam rules require every business that sends text messages to be registered with the
        carriers&apos; national registry. <b>We file the whole thing for you</b> — you never deal with a registry
        or a carrier.
      </p>

      {showIdentity && (
        <>
          <div className="ob-field-row">
            <div>
              <label className="ob-label">Legal business name</label>
              <input className="ob-input" placeholder="Weiss Plumbing LLC" value={t.legalName}
                onChange={(e) => onChange({ legalName: e.target.value })} />
            </div>
            <div>
              <label className="ob-label">Business type</label>
              <ConnectSelect
                value={t.entityType}
                onChange={(v) => onChange({ entityType: v as TextingState["entityType"] })}
                placeholder="Choose…"
                theme={theme}
                options={ENTITY_OPTIONS}
              />
            </div>
          </div>
          <div className="ob-field-row">
            <div>
              <label className="ob-label">EIN (federal tax ID)</label>
              {/* ⛔ autoComplete off + no autosave: this value never persists
                  anywhere on our side. See the header comment. */}
              <input className="ob-input" placeholder="82-1234567" inputMode="numeric" autoComplete="off"
                value={t.noEin ? "" : ein} disabled={t.noEin}
                onChange={(e) => onEinChange(e.target.value.replace(/[^\d-]/g, "").slice(0, 10))} />
              <button type="button" className="ob-tx-noein" onClick={() => onChange({ noEin: !t.noEin })}>
                {t.noEin ? "I do have an EIN" : "I don’t have an EIN"}
              </button>
            </div>
            <div>
              <label className="ob-label">Industry</label>
              <ConnectSelect
                value={t.vertical}
                onChange={(v) => onChange({ vertical: v })}
                placeholder="Choose…"
                theme={theme}
                options={VERTICAL_OPTIONS}
              />
            </div>
          </div>
          <div className="ob-field-row">
            <div>
              <label className="ob-label">Business website <span className="ob-label-optional">social page works</span></label>
              <input className="ob-input" placeholder="weissplumbingny.com" value={t.website}
                onChange={(e) => onChange({ website: e.target.value })} />
            </div>
            <div>
              <label className="ob-label">Business address</label>
              <div className="ob-tx-samefld">{serviceAddress ? `${serviceAddress} ✓` : "Same as your service address ✓"}</div>
            </div>
          </div>
          {t.noEin && (
            <div className="ob-field-hint" style={{ marginTop: 2 }}>
              No problem — sole proprietors can register with a person&apos;s help instead of an EIN. Texting starts
              in a limited class (about 1,000 messages a day, one number) and we&apos;ll reach out to finish the
              registration with you.
            </div>
          )}
          <div className="ob-tx-lock">
            <span aria-hidden>🔒</span>
            <div>
              <b>Your EIN is never saved on your Loopcom account.</b> The moment you press Continue it travels over
              an encrypted connection straight to the carrier registry, and the only thing kept on your account is
              the registry&apos;s approval reference.
            </div>
          </div>
        </>
      )}

      {showUsage && (
        <>
          <div className="ob-tx-subhead">How will your business use texting?</div>
          <div className="ob-tx-choices">
            <div className={`ob-tx-choice${t.classification === "conversational" ? " on" : ""}`} tabIndex={0}
              onClick={() => onChange({ classification: "conversational" })}
              onKeyDown={(e) => e.key === "Enter" && onChange({ classification: "conversational" })}>
              <Radio on={t.classification === "conversational"} />
              <div>
                <div className="ob-tx-choice-t">Conversations with my customers</div>
                <div className="ob-tx-choice-d">
                  People text your number, your team replies. Registered as a standard business-texting campaign —
                  up to <b>2,000 messages a day</b>, the carrier limit for this class.
                </div>
              </div>
            </div>
            <div className={`ob-tx-choice${t.classification === "marketing" ? " on" : ""}`} tabIndex={0}
              onClick={() => onChange({ classification: "marketing" })}
              onKeyDown={(e) => e.key === "Enter" && onChange({ classification: "marketing" })}>
              <Radio on={t.classification === "marketing"} />
              <div>
                <div className="ob-tx-choice-t">Promotions, reminders, or automated messages</div>
                <div className="ob-tx-choice-d">
                  Anything sent by a system — specials, blasts, appointment reminders. Carriers review this class
                  more strictly, so a few more questions open below.
                </div>
              </div>
            </div>
          </div>

          {t.classification === "marketing" && (
            <div className="ob-tx-marketing">
              <label className="ob-label">What sends these messages?</label>
              <div className="ob-tx-choices" style={{ marginBottom: 12 }}>
                <div className={`ob-tx-choice sm${t.senderSystem === "loopcom" ? " on" : ""}`} tabIndex={0}
                  onClick={() => onChange({ senderSystem: "loopcom" })}
                  onKeyDown={(e) => e.key === "Enter" && onChange({ senderSystem: "loopcom" })}>
                  <Radio on={t.senderSystem === "loopcom"} />
                  <div>
                    <div className="ob-tx-choice-t">Loopcom sends them for me</div>
                    <div className="ob-tx-choice-d">
                      Campaigns, reminders and specials from your Loopcom system. <b className="ob-tx-good">Nothing to
                      fill in</b> — we already know exactly what these messages look like, so we complete the carrier
                      paperwork for you.
                    </div>
                  </div>
                </div>
                <div className={`ob-tx-choice sm${t.senderSystem === "own" ? " on" : ""}`} tabIndex={0}
                  onClick={() => onChange({ senderSystem: "own" })}
                  onKeyDown={(e) => e.key === "Enter" && onChange({ senderSystem: "own" })}>
                  <Radio on={t.senderSystem === "own"} />
                  <div>
                    <div className="ob-tx-choice-t">My own software or another service sends them through my number</div>
                    <div className="ob-tx-choice-d">Then only you know what those messages say — describe them below.</div>
                  </div>
                </div>
              </div>

              {t.senderSystem === "own" && (
                <>
                  <details className="ob-tx-why">
                    <summary><span aria-hidden>▸</span> Why do we ask for this?</summary>
                    <div>
                      This is the minimum the carriers require — we&apos;ve filled in everything we possibly can for
                      you, and these last answers only you have. Carriers compare the texts you actually send against
                      what&apos;s registered here, and when they don&apos;t match they can{" "}
                      <b className="ob-tx-danger">silently block your messages — they simply never arrive</b>, with no
                      error and no warning to you or your customer. Two minutes here is what protects your delivery.
                    </div>
                  </details>
                  <div className="ob-field">
                    <label className="ob-label">What will you send, and how do people sign up to receive it?</label>
                    <input className="ob-input" placeholder="e.g. Weekly specials to customers who signed up at checkout or texted JOIN"
                      value={t.messageFlow} onChange={(e) => onChange({ messageFlow: e.target.value })} />
                  </div>
                  <div className="ob-field-row">
                    <div>
                      <label className="ob-label">Example message 1</label>
                      <input className="ob-input" placeholder="This week at Weiss Plumbing: …" value={t.sample1}
                        onChange={(e) => onChange({ sample1: e.target.value })} />
                    </div>
                    <div>
                      <label className="ob-label">Example message 2</label>
                      <input className="ob-input" placeholder="Reminder: your appointment is …" value={t.sample2}
                        onChange={(e) => onChange({ sample2: e.target.value })} />
                    </div>
                  </div>
                  <div className="ob-field-row">
                    <div>
                      <label className="ob-label">Messages per day, roughly</label>
                      <ConnectSelect
                        value={t.volume}
                        onChange={(v) => onChange({ volume: v })}
                        placeholder="Choose…"
                        theme={theme}
                        options={[
                          { value: "under_2000", label: "Under 2,000" },
                          { value: "2000_10000", label: "2,000 – 10,000" },
                          { value: "over_10000", label: "More than 10,000" },
                        ]}
                      />
                    </div>
                    <div className="ob-tx-stopnote">Every message includes &ldquo;Reply STOP to opt out&rdquo; automatically.</div>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="ob-tx-price">
            <div><span>Texting service</span><b>$10.00 / mo</b></div>
            <div><span>One-time carrier registration filing</span><b>$15.00 once</b></div>
            <div><span>Monthly carrier campaign fee</span><b>included</b></div>
          </div>
          <div className="ob-tl-line"><span className="ob-tl-dot" />Carrier approval usually takes 1–5 business days</div>
          <div className="ob-tl-line">
            <span className="ob-tl-dot" />
            Your phone service starts right away — texting switches on automatically the moment carriers approve, and we email you
          </div>
          <label className="ob-tx-consent">
            <input type="checkbox" checked={consent} onChange={(e) => onConsentChange(e.target.checked)} />
            <span>
              I authorize <b>Loopcom LLC</b> to file this registration with The Campaign Registry and U.S. carriers on
              my company&apos;s behalf, and I agree texts my business sends follow the anti-spam rules (recipients can
              reply STOP at any time).
            </span>
          </label>
        </>
      )}
    </div>
  );
}
