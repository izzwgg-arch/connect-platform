"use client";

/**
 * The PHONE version of the sign-up wizard — the 2026-08-30 approved mobile
 * mockups, built exactly: the same wizard link measures the screen (no
 * user-agent games, no separate mobile site) and breaks every desktop step
 * into micro-screens — one question at a time, a progress ring in the corner,
 * the Continue button pinned where the thumb already is, nothing ever a long
 * scroll. Screens glide in ~200ms; the ring fills as they advance; both stand
 * down under prefers-reduced-motion (CSS side).
 *
 * ⛔ NO SECOND STATE MACHINE. This component renders micro-screens WITHIN the
 * page's existing `step` state and drives the SAME side effects through the
 * closures the page hands it (`fireApplyNumber`, `fileTexting`, `advance`,
 * `handleSubmit`) — the quote/portability/auto-search/checkout effects are all
 * keyed on `step`, so they fire identically on a phone. Duplicating any of it
 * here is the two-publish-paths drift. Someone can start on their phone and
 * finish on a computer (or the reverse): both render from the same autosaved
 * draft.
 */

import { useEffect, useRef, useState } from "react";
import { TextingRegistrationCard, type TextingState } from "./textingStep";

type CellMode = "" | "also" | "only";
type Extension = { displayName: string; extNumber: string; email: string; vmPassword: string; cellMode: CellMode; cellNumber: string; isOwner: boolean };
type SearchMode = "areacode" | "starts" | "contains" | "ends";
type AvailableNumber = { number: string; location: string; sms: boolean; voice: boolean; mms?: boolean; fax?: boolean; inStock?: boolean; kind?: string };

export type MobileWiz = {
  form: any;
  step: number;
  stepError: string | null;
  setStepError: (v: string | null) => void;
  updateForm: (patch: any) => void;
  updateExt: (i: number, patch: Partial<Extension>) => void;
  addExt: () => void;
  removeExt: (i: number) => void;
  setOwnerExt: (i: number) => void;
  validateStep: (s: number) => string | null;
  /** The tail of goNext: track + setStep + autosave + scroll. */
  advance: (next: number) => void;
  goBack: () => void;
  fireApplyNumber: () => void;
  fileTexting: () => Promise<string | null>;
  textingFiling: boolean;
  // Number search
  numbers: AvailableNumber[];
  numbersLoading: boolean;
  numbersError: string | null;
  numbersNone: string | null;
  numbersQuery: string;
  setNumbersQuery: (v: string) => void;
  searchMode: SearchMode;
  setSearchMode: (m: SearchMode) => void;
  searchNumbers: (q: string, opts?: any) => void;
  numbersProvider: "voipms" | "signalwire" | null;
  searchRegion: string;
  setSearchRegion: (v: string) => void;
  portability: "idle" | "checking" | "portable" | "unknown";
  uploadPortDoc: (kind: "loa" | "bill", file: File) => void;
  uploading: { loa: boolean; bill: boolean };
  // Texting
  ein: string;
  setEin: (v: string) => void;
  textingConsent: boolean;
  setTextingConsent: (v: boolean) => void;
  // Review / payment
  quote: { lines: Array<{ key: string; label: string; totalCents: number }>; monthlyTotalCents: number } | null;
  money: (cents: number) => string;
  handleSubmit: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;
  startCheckout: () => Promise<void>;
  retryCheckout: () => void;
  checkoutError: string | null;
  saveState: string;
  themeLabel: "dark" | "light";
  toggleTheme: () => void;
};

/** step → its micro-screens, given the current answers. */
function subsForStep(step: number, form: any): string[] {
  if (step === 0) return ["company", "you"];
  if (step === 1) return ["address"];
  if (step === 2) {
    if (form.numberChoice === "port") return ["choice", "port1", "port2"];
    if (form.numberChoice === "new") return ["choice", "pick"];
    return ["choice"];
  }
  if (step === 3) return ["people"];
  if (step === 4) {
    return form.smsEnabled && form.texting.classification ? ["fork", "reg"] : ["fork"];
  }
  if (step === 5) return ["review"];
  return ["pay"];
}

/** The 1..9 ring position for a screen (mockup numbering). */
function ringPosition(step: number, sub: string): { n: number; of: number } {
  const map: Record<string, number> = {
    company: 1, you: 2, address: 3, choice: 4, pick: 5, port1: 5, port2: 5,
    people: 6, fork: 7, reg: 7, review: 8, pay: 9,
  };
  return { n: map[sub] ?? Math.min(9, step + 1), of: 9 };
}

export function MobileWizard({ wiz }: { wiz: MobileWiz }) {
  const {
    form, step, stepError, setStepError, updateForm,
  } = wiz;
  const [subIdx, setSubIdx] = useState(0);
  const lastStep = useRef(step);
  // A step change from OUTSIDE (resume, back) lands on that step's first
  // screen; going back from a step's first screen lands on the previous
  // step's LAST screen (handled in back()).
  useEffect(() => {
    if (lastStep.current !== step) {
      lastStep.current = step;
      setSubIdx(0);
    }
  }, [step]);
  // Slide-in keyed per screen; CSS handles reduced-motion.
  const subs = subsForStep(step, form);
  const sub = subs[Math.min(subIdx, subs.length - 1)] ?? subs[0]!;
  const ring = ringPosition(step, sub);

  function fail(msg: string) {
    setStepError(msg);
  }

  async function continueFrom(current: string) {
    setStepError(null);
    // Per-screen checks first (friendlier than failing at the step boundary),
    // then the page's full validateStep gate when leaving the step.
    if (current === "company" && String(form.companyName || "").trim().length < 2) return fail("Company name must be at least 2 characters.");
    if (current === "you") {
      if (!String(form.firstName || "").trim()) return fail("First name is required.");
      if (!String(form.lastName || "").trim()) return fail("Last name is required.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.mainEmail || "").trim())) return fail("A valid email is required.");
      if (String(form.mainPhone || "").trim().length < 7) return fail("A valid cell number is required.");
    }
    if (current === "choice" && !form.numberChoice) return fail("Pick a path — a new number, or bring yours.");
    if (current === "pick" && !form.selectedNumber) return fail("Pick a number from the list.");
    if (current === "port1") {
      if (String(form.porting.numbers || "").trim().length < 7) return fail("Enter the number you'd like to bring over.");
      if (String(form.porting.carrier || "").trim().length < 2) return fail("Your current carrier is required.");
      if (String(form.porting.accountNumber || "").trim().length < 1) return fail("Your carrier account number is required.");
      if (form.porting.isMobile && !String(form.porting.portPin || "").trim()) return fail("Cell number transfers need the transfer PIN from your carrier.");
    }
    if (current === "fork") {
      if (!form.smsEnabled) {
        // "No texting for now" — skip the registration screen entirely.
        wiz.advance(step + 1);
        return;
      }
      if (!form.texting.classification) return fail("Choose how your business will use texting.");
    }

    const isLastSub = subIdx >= subs.length - 1;
    if (!isLastSub) {
      setSubIdx((i) => i + 1);
      window.scrollTo({ top: 0 });
      return;
    }

    // Leaving the step — the page's own gate + side effects, never a copy.
    const err = wiz.validateStep(step);
    if (err) return fail(err);
    if (step === 4 && form.smsEnabled) {
      const txErr = await wiz.fileTexting();
      if (txErr) return fail(txErr);
    }
    if (step === 2) wiz.fireApplyNumber();
    if (step === 5) {
      await wiz.handleSubmit();
      return;
    }
    wiz.advance(step + 1);
  }

  function back() {
    setStepError(null);
    if (subIdx > 0) {
      setSubIdx((i) => i - 1);
      return;
    }
    if (step > 0) {
      // Land on the previous step's LAST screen.
      const prevSubs = subsForStep(step - 1, form);
      wiz.goBack();
      // goBack sets step; the step-change effect resets subIdx to 0 — override
      // to the last screen on the next tick.
      setTimeout(() => setSubIdx(prevSubs.length - 1), 0);
    }
  }

  const ctaLabel = (() => {
    if (sub === "pick" && form.selectedNumber) return `Use ${form.selectedNumber}`;
    if (sub === "reg") return wiz.textingFiling ? "Filing your registration…" : "File my registration";
    if (sub === "review") return wiz.submitting ? "Saving…" : "Continue to payment";
    return "Continue";
  })();

  const titles: Record<string, [string, string]> = {
    company: ["Let’s set up your phone system", "About five minutes. Your progress saves by itself — come back any time, on any device."],
    you: ["About you", "The owner of the account — you can add your team in a minute."],
    address: ["Where are your phones?", "This is also your 911 address — it’s registered to your number after payment."],
    choice: ["Your business number", "Pick the path — both take about a minute."],
    pick: ["Pick your business number", "Set aside now — purchased only after payment."],
    port1: ["Your current number", "From your current carrier’s account — a recent bill has all of it."],
    port2: ["Authorize the transfer", "Your carrier requires a signed letter before releasing the number — sign with your name and we file everything."],
    people: ["Who answers the phone?", "Each person gets an extension and the app — $30/mo per person."],
    fork: ["Business texting?", "Send and receive texts from your business number — $10/mo."],
    reg: ["Register your business for texting", "Required by U.S. carriers — we file it for you. Approval takes 1–5 business days."],
    review: ["Review your setup", "Nothing is purchased or filed until you pay."],
    pay: ["Taking you to payment…", "Secured & powered by Sola — the same payment page every Loopcom customer uses."],
  };
  const [title, hint] = titles[sub] ?? ["", ""];

  return (
    <div className="ob-mshell">
      <div className="ob-mbar">
        {(step > 0 || subIdx > 0) && sub !== "pay" ? (
          <button className="ob-mback" onClick={back} aria-label="Back">‹</button>
        ) : <span style={{ width: 30 }} />}
        <div className="ob-msave">
          {wiz.saveState === "saving" && "Saving…"}
          {wiz.saveState === "saved" && "Saved"}
          {(wiz.saveState === "retrying" || wiz.saveState === "failed") && <span className="ob-save-warn">Not saved</span>}
        </div>
        <button className="ob-mtheme" onClick={wiz.toggleTheme} aria-label="Toggle theme">{wiz.themeLabel === "dark" ? "☾" : "☀"}</button>
        <span className="ob-mring" style={{ ["--p" as any]: `${Math.round((ring.n / ring.of) * 100)}%` }} data-n={`${ring.n}/${ring.of}`} aria-label={`Step ${ring.n} of ${ring.of}`} />
      </div>

      <div className="ob-mscreen" key={`${step}:${sub}`}>
        <div className="ob-mtitle">{title}</div>
        <div className="ob-mhint">{hint}</div>

        {sub === "company" && (
          <div className="ob-mfields">
            <div><label className="ob-label">Your company name</label>
              <input className="ob-input" placeholder="Weiss Plumbing LLC" value={form.companyName} onChange={(e) => updateForm({ companyName: e.target.value })} /></div>
          </div>
        )}

        {sub === "you" && (
          <div className="ob-mfields">
            <div className="ob-mrow2">
              <div><label className="ob-label">First name</label><input className="ob-input" value={form.firstName} onChange={(e) => updateForm({ firstName: e.target.value })} /></div>
              <div><label className="ob-label">Last name</label><input className="ob-input" value={form.lastName} onChange={(e) => updateForm({ lastName: e.target.value })} /></div>
            </div>
            <div><label className="ob-label">Email</label><input className="ob-input" type="email" inputMode="email" autoComplete="email" value={form.mainEmail} onChange={(e) => updateForm({ mainEmail: e.target.value })} /></div>
            <div><label className="ob-label">Cell number</label><input className="ob-input" inputMode="tel" autoComplete="tel" placeholder="(845) 555-0182" value={form.mainPhone} onChange={(e) => updateForm({ mainPhone: e.target.value })} /></div>
          </div>
        )}

        {sub === "address" && (
          <div className="ob-mfields">
            <div><label className="ob-label">Street address</label><input className="ob-input" placeholder="30 Robert Pitt Dr" value={form.address} onChange={(e) => updateForm({ address: e.target.value })} /></div>
            <div><label className="ob-label">City</label><input className="ob-input" placeholder="Monsey" value={form.addressCity} onChange={(e) => updateForm({ addressCity: e.target.value })} /></div>
            <div className="ob-mrow2">
              <div><label className="ob-label">State</label><input className="ob-input" placeholder="NY" maxLength={2} value={form.addressState} onChange={(e) => updateForm({ addressState: e.target.value.toUpperCase() })} /></div>
              <div><label className="ob-label">ZIP</label><input className="ob-input" placeholder="10952" inputMode="numeric" maxLength={5} value={form.addressZip} onChange={(e) => updateForm({ addressZip: e.target.value.replace(/\D/g, "") })} /></div>
            </div>
          </div>
        )}

        {sub === "choice" && (
          <div className="ob-mfields">
            <div className={`ob-mcard${form.numberChoice === "new" ? " on" : ""}`} tabIndex={0}
              onClick={() => updateForm({ numberChoice: "new" })}
              onKeyDown={(e) => e.key === "Enter" && updateForm({ numberChoice: "new" })}>
              <div className="ob-mcard-t">Get a new number</div>
              <div className="ob-mcard-d">Search by area code — or spell a word.</div>
            </div>
            <div className={`ob-mcard${form.numberChoice === "port" ? " on" : ""}`} tabIndex={0}
              onClick={() => updateForm({ numberChoice: "port" })}
              onKeyDown={(e) => e.key === "Enter" && updateForm({ numberChoice: "port" })}>
              <div className="ob-mcard-t">Bring my existing number</div>
              <div className="ob-mcard-d">Keep the number your customers know. A temporary number works today.</div>
            </div>
          </div>
        )}

        {sub === "pick" && (
          <div className="ob-mfields">
            <div className="ob-modes ob-modes-scroll">
              {([["areacode", "Area code"], ["starts", "Starts with"], ["contains", "Contains"], ["ends", "Ends with"]] as [SearchMode, string][]).map(([m, label]) => (
                <button key={m} type="button" className={`ob-mode${wiz.searchMode === m ? " on" : ""}`} onClick={() => wiz.setSearchMode(m)}>{label}</button>
              ))}
            </div>
            <div className="ob-searchbar">
              <input className="ob-input" style={{ minWidth: 0 }} placeholder={wiz.searchMode === "areacode" ? "845" : "5667 or LOOP"} value={wiz.numbersQuery}
                onChange={(e) => wiz.setNumbersQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !wiz.numbersLoading && wiz.searchNumbers(wiz.numbersQuery, { tab: "local", mode: wiz.searchMode })} />
              <button className="ob-btn-ghost" disabled={wiz.numbersLoading} onClick={() => wiz.searchNumbers(wiz.numbersQuery, { tab: "local", mode: wiz.searchMode })}>
                {wiz.numbersLoading ? "…" : "Search"}
              </button>
            </div>
            <div className="ob-t9">Letters work — <code>LOOP</code> searches <code>5667</code>.</div>
            {wiz.numbersLoading && <div className="ob-field-hint">Finding available numbers…</div>}
            {wiz.numbersError && <div className="ob-field-hint">{wiz.numbersError}</div>}
            {!wiz.numbersLoading && wiz.numbersNone && wiz.numbers.length === 0 && <div className="ob-num-empty" role="status">{wiz.numbersNone}</div>}
            <div className="ob-mlist">
              {wiz.numbers.map((n) => (
                <div key={n.number} className={`ob-mnum${form.selectedNumber === n.number ? " on" : ""}`} tabIndex={0}
                  onClick={() => updateForm({ selectedNumber: n.number, numberKind: n.kind || "local" })}
                  onKeyDown={(e) => e.key === "Enter" && updateForm({ selectedNumber: n.number, numberKind: n.kind || "local" })}>
                  <div>
                    <div className="ob-num-n">{n.number}</div>
                    {n.location && <div className="ob-num-loc">{n.location}</div>}
                  </div>
                  <div className="ob-caps">
                    {n.sms && <span className="ob-cap">SMS</span>}
                    {n.mms && <span className="ob-cap">MMS</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {sub === "port1" && (
          <div className="ob-mfields">
            <div><label className="ob-label">Number you’re bringing</label><input className="ob-input" inputMode="tel" placeholder="(347) 555-0182" value={form.porting.numbers} onChange={(e) => updateForm({ porting: { ...form.porting, numbers: e.target.value } })} /></div>
            <div><label className="ob-label">Current carrier</label><input className="ob-input" placeholder="Verizon" value={form.porting.carrier} onChange={(e) => updateForm({ porting: { ...form.porting, carrier: e.target.value } })} /></div>
            <div className="ob-mrow2">
              <div><label className="ob-label">Account number</label><input className="ob-input" value={form.porting.accountNumber} onChange={(e) => updateForm({ porting: { ...form.porting, accountNumber: e.target.value } })} /></div>
              <div><label className="ob-label">Transfer PIN</label><input className="ob-input" value={form.porting.portPin} onChange={(e) => updateForm({ porting: { ...form.porting, portPin: e.target.value } })} /></div>
            </div>
            <label className="ob-mcheck">
              <input type="checkbox" checked={form.porting.isMobile} onChange={(e) => updateForm({ porting: { ...form.porting, isMobile: e.target.checked } })} />
              <span>This is a cell number</span>
            </label>
            {wiz.portability === "portable" && <div className="ob-field-hint">✓ {form.porting.numbers} can be transferred.</div>}
          </div>
        )}

        {sub === "port2" && (
          <div className="ob-mfields">
            <div><label className="ob-label">Street address on the bill</label><input className="ob-input" value={form.porting.serviceAddress} onChange={(e) => updateForm({ porting: { ...form.porting, serviceAddress: e.target.value } })} /></div>
            <div className="ob-mrow2">
              <div><label className="ob-label">City</label><input className="ob-input" value={form.porting.serviceCity} onChange={(e) => updateForm({ porting: { ...form.porting, serviceCity: e.target.value } })} /></div>
              <div className="ob-mrow2" style={{ gap: 8 }}>
                <div><label className="ob-label">State</label><input className="ob-input" maxLength={2} value={form.porting.serviceState} onChange={(e) => updateForm({ porting: { ...form.porting, serviceState: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") } })} /></div>
                <div><label className="ob-label">ZIP</label><input className="ob-input" inputMode="numeric" maxLength={5} value={form.porting.serviceZip} onChange={(e) => updateForm({ porting: { ...form.porting, serviceZip: e.target.value.replace(/\D/g, "") } })} /></div>
              </div>
            </div>
            <div><label className="ob-label">Name on the account</label><input className="ob-input" value={form.porting.nameOnAccount} onChange={(e) => updateForm({ porting: { ...form.porting, nameOnAccount: e.target.value } })} /></div>
            <label className={`ob-upl${form.porting.billFileName ? " done" : ""}`} style={{ minHeight: 0 }}>
              <input type="file" accept="application/pdf,image/*" capture="environment" style={{ display: "none" }} disabled={wiz.uploading.bill}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) wiz.uploadPortDoc("bill", f); }} />
              <b>{wiz.uploading.bill ? "Uploading…" : form.porting.billFileName ? `📎 ${form.porting.billFileName}` : "📎 Tap to add a photo of a recent bill"}</b>
            </label>
            <div><label className="ob-label">Sign with your full name</label>
              <input className="ob-input ob-sig" placeholder="Type your full name to sign" autoComplete="name" value={form.porting.loaSignature}
                onChange={(e) => updateForm({ porting: { ...form.porting, loaSignature: e.target.value } })} /></div>
            <div>
              <div className="ob-tl-line"><span className="ob-tl-dot" />Temporary number works today</div>
              <div className="ob-tl-line"><span className="ob-tl-dot" />~7 business days to transfer</div>
              <div className="ob-tl-line"><span className="ob-tl-dot" />Switches over by itself</div>
            </div>
          </div>
        )}

        {sub === "people" && (
          <div className="ob-mfields">
            {(form.extensions as Extension[]).map((ext, i) => (
              <div key={i} className="ob-mperson">
                <div className="ob-mperson-head">
                  <label className="ob-mcheck" title="Account owner">
                    <input type="radio" name="ob-m-owner" checked={ext.isOwner} onChange={() => wiz.setOwnerExt(i)} />
                    <span>Owner</span>
                  </label>
                  {form.extensions.length > 1 && (
                    <button className="ob-ext-remove" onClick={() => wiz.removeExt(i)} title="Remove">×</button>
                  )}
                </div>
                <div className="ob-mrow2">
                  <div><label className="ob-label">Name</label><input className="ob-input" placeholder="Jane Smith" value={ext.displayName} onChange={(e) => wiz.updateExt(i, { displayName: e.target.value })} /></div>
                  <div><label className="ob-label">Ext #</label><input className="ob-input" placeholder="101" inputMode="numeric" value={ext.extNumber} onChange={(e) => wiz.updateExt(i, { extNumber: e.target.value.replace(/\D/g, "") })} /></div>
                </div>
                <div><label className="ob-label">Email {ext.isOwner ? "" : "(optional)"}</label><input className="ob-input" type="email" inputMode="email" value={ext.email} onChange={(e) => wiz.updateExt(i, { email: e.target.value })} /></div>
              </div>
            ))}
            <button className="ob-mcard ob-madd" onClick={wiz.addExt}>+ Add another person</button>
          </div>
        )}

        {sub === "fork" && (
          <div className="ob-mfields">
            <div className={`ob-mcard${form.smsEnabled && form.texting.classification === "conversational" ? " on" : ""}`} tabIndex={0}
              onClick={() => updateForm({ smsEnabled: true, texting: { ...form.texting, classification: "conversational" } })}
              onKeyDown={(e) => e.key === "Enter" && updateForm({ smsEnabled: true, texting: { ...form.texting, classification: "conversational" } })}>
              <div className="ob-mcard-t">Conversations with my customers</div>
              <div className="ob-mcard-d">Up to 2,000 messages a day — the carrier limit for this class.</div>
            </div>
            <div className={`ob-mcard${form.smsEnabled && form.texting.classification === "marketing" ? " on" : ""}`} tabIndex={0}
              onClick={() => updateForm({ smsEnabled: true, texting: { ...form.texting, classification: "marketing" } })}
              onKeyDown={(e) => e.key === "Enter" && updateForm({ smsEnabled: true, texting: { ...form.texting, classification: "marketing" } })}>
              <div className="ob-mcard-t">Promotions or automated messages</div>
              <div className="ob-mcard-d">A few more carrier questions open up.</div>
            </div>
            <div className={`ob-mcard${!form.smsEnabled ? " on" : ""}`} tabIndex={0}
              onClick={() => updateForm({ smsEnabled: false })}
              onKeyDown={(e) => e.key === "Enter" && updateForm({ smsEnabled: false })}>
              <div className="ob-mcard-t">No texting for now</div>
              <div className="ob-mcard-d">You can turn it on any time later.</div>
            </div>
          </div>
        )}

        {sub === "reg" && (
          <TextingRegistrationCard
            texting={form.texting as TextingState}
            onChange={(patch) => updateForm({ texting: { ...form.texting, ...patch } })}
            ein={wiz.ein}
            onEinChange={wiz.setEin}
            consent={wiz.textingConsent}
            onConsentChange={wiz.setTextingConsent}
            theme={wiz.themeLabel}
            serviceAddress={[form.address, form.addressCity].filter(Boolean).join(", ")}
          />
        )}

        {sub === "review" && (
          <div className="ob-mfields">
            <div className="ob-mrline"><span>Number</span><b>{form.numberChoice === "port" ? form.porting.numbers : form.selectedNumber || "—"}</b></div>
            <div className="ob-mrline"><span>911 address</span><b>{form.address || "—"}</b></div>
            <div className="ob-mrline"><span>People</span><b>{(form.extensions as Extension[]).filter((e) => e.extNumber).length} × $30/mo</b></div>
            <div className="ob-mrline"><span>Texting</span><b>{form.smsEnabled ? "$10/mo + $15 once" : "Not added"}</b></div>
            {wiz.quote && (
              <div className="ob-mrline ob-mrline-total"><span>Monthly total</span><b>{wiz.money(wiz.quote.monthlyTotalCents)}</b></div>
            )}
            {wiz.submitError && <div className="ob-error">{wiz.submitError}</div>}
          </div>
        )}

        {sub === "pay" && (
          <div className="ob-mfields">
            {wiz.checkoutError ? (
              <>
                <div className="ob-error">{wiz.checkoutError}</div>
                <button className="ob-btn-next" onClick={wiz.retryCheckout}>Try again</button>
              </>
            ) : (
              <div className="ob-field-hint">
                <div className="ob-spinner" style={{ width: 22, height: 22, marginBottom: 10 }} />
                Preparing your secure checkout… your card stays on file — that&apos;s how each month is paid.
                Card details go straight to the payment provider; they never touch our servers.
              </div>
            )}
          </div>
        )}

        {stepError && sub !== "review" && <div className="ob-error">{stepError}</div>}
      </div>

      {sub !== "pay" && (
        <div className="ob-mcta">
          <button className="ob-btn-next" style={{ width: "100%" }} disabled={wiz.textingFiling || wiz.submitting}
            onClick={() => void continueFrom(sub)}>
            {ctaLabel}
          </button>
        </div>
      )}
    </div>
  );
}
