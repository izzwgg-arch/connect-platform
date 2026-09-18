"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPortalApiBaseUrl } from "../../../services/apiClient";
import { ConnectSelect } from "../../../components/ConnectSelect";
import { LoginThemeToggle } from "../../../components/LoginThemeToggle";
import "./texting-registration.css";

/**
 * The customer's 10DLC form — opened from the link Loopcom emails or sends.
 *
 * Izzy, 2026-09-16: "wherever the system could fill in, the system should
 * already have filled it in … they could see it, just not edit it, only the
 * information that we need from them."
 *
 * ⛔ PUBLIC BY TOKEN: no sign-in, plain fetch against the public api base; the
 * api re-checks the token on every request and returns only the customer view.
 * ⛔ EDITABLE: legal name, business type, EIN, IRS address, website (and the
 * owner's mobile for a sole proprietor), signature, consent. Everything else is
 * shown locked. When the registration was sent back, ONLY the fields named in
 * `fixFields` are editable.
 * ⛔ The EIN is never autosaved and never shown back.
 * ⛔ No carrier name and no price anywhere on this page (source-guarded).
 */

type Wording = {
  description: string;
  sample1: string;
  sample2: string;
  optinFlow: string;
  helpMessage: string;
  optoutMessage: string;
  optinMessage: string;
  optoutKeywords: string;
  helpKeywords: string;
};

type View = {
  phase: "form" | "pin" | "sent";
  displayName: string;
  businessPhone: string;
  businessEmail: string;
  contactName: string | null;
  numbers: string[];
  answers: Record<string, string>;
  einOnFile: boolean;
  fixFields: string[] | null;
  fixNote: string | null;
  submittedAt: string | null;
  signatureName: string | null;
  wording: Wording;
  privacyUrl: string;
  termsUrl: string;
};

type Unavailable = { error: string; message: string; displayName: string | null; submittedAt: string | null; signatureName: string | null };

// Izzy, 2026-09-18: "Entity type should just ask: LLC, Corporation, C corp." Every one of
// these is a privately held for-profit business, which the registry calls PRIVATE_PROFIT —
// so the choice is only what the customer SEES; the value filed is always PRIVATE_PROFIT.
// ⛔ Never offer "Publicly traded company" here: the registry demands a stock exchange,
// ticker and business contact email for it, which this form does not collect (Gesheft picked
// it on 2026-09-18 and every File press was refused at the door). Non-profit, government and
// sole proprietor exist only on the staff review page, where the checks explain themselves.
const BUSINESS_KIND_OPTIONS = [
  { value: "LLC", label: "LLC" },
  { value: "CORPORATION", label: "Corporation" },
  { value: "C_CORP", label: "C corp" },
];
const KIND_ENTITY_TYPE = "PRIVATE_PROFIT";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY"
  .split(" ")
  .map((s) => ({ value: s, label: s }));

function fmtPhone(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : raw;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </svg>
  );
}

export default function TextingRegistrationPage({ params }: { params: { token: string } }) {
  const token = String(params?.token ?? "");
  const base = `${getPortalApiBaseUrl()}/texting-registration/${encodeURIComponent(token)}`;

  const [view, setView] = useState<View | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [ein, setEin] = useState("");
  const [signature, setSignature] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [pinDone, setPinDone] = useState(false);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(base, { headers: { accept: "application/json" }, cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (body?.error?.startsWith?.("link_")) setUnavailable(body);
        else setLoadError(body?.message || "This page couldn't load. Try again in a minute.");
        return;
      }
      setView(body);
      setAnswers({ ...(body.answers || {}) });
    } catch {
      setLoadError("This page couldn't load. Check your connection and try again.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = useCallback(
    (field: string) => !view?.fixFields || view.fixFields.includes(field),
    [view],
  );

  // Autosave what they've typed (never the EIN), so closing the tab loses nothing.
  useEffect(() => {
    if (!view || view.phase !== "form" || !dirty.current) return;
    const t = setTimeout(() => {
      const body: Record<string, string> = {};
      for (const k of ["legalName", "entityType", "street", "city", "state", "postalCode", "website", "mobilePhone"]) {
        if (editable(k) && typeof answers[k] === "string") body[k] = answers[k];
      }
      void fetch(`${base}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    }, 1200);
    return () => clearTimeout(t);
  }, [answers, base, view, editable]);

  const set = (k: string, v: string) => {
    dirty.current = true;
    setAnswers((a) => ({ ...a, [k]: v }));
    setErrors((e) => {
      if (!e[k]) return e;
      const n = { ...e };
      delete n[k];
      return n;
    });
  };

  const sole = answers.entityType === "SOLE_PROPRIETOR";
  // What the customer picked from the three plain choices; only the registry value is stored.
  const [businessKind, setBusinessKind] = useState("");

  const submit = async () => {
    if (!view) return;
    setBusy(true);
    setBanner(null);
    try {
      const body: Record<string, unknown> = { ...answers, signatureName: signature, consent };
      if (editable("ein") && !sole) body.ein = ein;
      const r = await fetch(`${base}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const res = await r.json().catch(() => ({}));
      if (r.status === 422 && res?.errors) {
        setErrors(res.errors);
        setBanner("Please fix the highlighted fields.");
        const first = Object.keys(res.errors)[0];
        document.getElementById(`tr-${first}`)?.focus();
        return;
      }
      if (!r.ok) {
        setBanner(res?.message || "That didn't go through. Try again in a minute.");
        return;
      }
      setEin("");
      setSubmitted(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setBanner("That didn't go through. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const verifyPin = async () => {
    setBusy(true);
    setPinMessage(null);
    try {
      const r = await fetch(`${base}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      const res = await r.json().catch(() => ({}));
      if (r.ok && res?.ok) setPinDone(true);
      else setPinMessage(res?.message || "That code wasn't accepted.");
    } catch {
      setPinMessage("That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const resendPin = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${base}/resend-pin`, { method: "POST" });
      const res = await r.json().catch(() => ({}));
      setPinMessage(r.ok ? "A new code is on its way." : res?.message || "Couldn't send a new code.");
    } finally {
      setBusy(false);
    }
  };

  const field = (k: string, label: string, input: React.ReactNode, hint?: string, full = false) => (
    <div className={`tr-field${full ? " tr-full" : ""}${errors[k] ? " tr-invalid" : ""}`}>
      <label htmlFor={`tr-${k}`}>
        {label}
        {editable(k) ? <span className="tr-req" aria-hidden="true">*</span> : null}
      </label>
      {input}
      {errors[k] ? <div className="tr-error" role="alert">{errors[k]}</div> : hint ? <div className="tr-hint">{hint}</div> : null}
    </div>
  );

  const text = (k: string, props: Record<string, unknown> = {}) => (
    <input
      id={`tr-${k}`}
      className="tr-input"
      value={answers[k] ?? ""}
      disabled={!editable(k)}
      onChange={(e) => set(k, e.target.value)}
      aria-invalid={!!errors[k]}
      {...props}
    />
  );

  const shell = (children: React.ReactNode) => (
    <main className="lc-login tr-page">
      <LoginThemeToggle />
      <div className="tr-card">
        <img className="tr-logo" src="/brand/loopcom/loopcom-wordmark-560.png" alt="Loopcom" width={560} height={99} />
        {children}
      </div>
    </main>
  );

  const lockedList = useMemo(() => {
    if (!view) return null;
    const rows: Array<[string, string]> = [
      ["Name customers see", view.displayName],
      ["Business phone", fmtPhone(view.businessPhone)],
      ["Business email", view.businessEmail],
    ];
    if (view.contactName) rows.push(["Contact", view.contactName]);
    if (view.numbers.length) rows.push([view.numbers.length === 1 ? "Number that will text" : "Numbers that will text", view.numbers.map(fmtPhone).join(", ")]);
    return rows;
  }, [view]);

  if (loadError) {
    return shell(
      <div className="tr-center">
        <h1>This page couldn&apos;t load</h1>
        <p className="tr-lede">{loadError}</p>
        <button type="button" className="tr-btn" onClick={() => { setLoadError(null); void load(); }}>Try again</button>
      </div>,
    );
  }

  if (unavailable) {
    const sent = unavailable.error === "link_used";
    return shell(
      <div className="tr-center">
        {sent ? <div className="tr-ok" aria-hidden="true">✓</div> : null}
        <h1>{sent ? "This registration was already sent" : unavailable.error === "link_revoked" ? "This link was replaced" : unavailable.error === "link_expired" ? "This link has expired" : "This link isn't valid"}</h1>
        <p className="tr-lede">
          {sent
            ? `${unavailable.displayName || "Your business"}'s registration was sent${unavailable.submittedAt ? ` on ${fmtDate(unavailable.submittedAt)}` : ""}${unavailable.signatureName ? ` by ${unavailable.signatureName}` : ""}. Nothing else is needed from you.`
            : "Ask Loopcom for a new link to the 10DLC form."}
        </p>
        <p className="tr-small">Questions? Call 845-723-1213.</p>
      </div>,
    );
  }

  if (!view) {
    return shell(<div className="tr-center"><p className="tr-lede">Loading…</p></div>);
  }

  if (submitted || view.phase === "sent") {
    return shell(
      <div className="tr-center">
        <div className="tr-ok" aria-hidden="true">✓</div>
        <h1>Thanks, we&apos;ve got it</h1>
        <p className="tr-lede">
          Loopcom is registering {view.displayName} for business texting now. Approval usually takes 3 to 5 business days, and we&apos;ll email {view.businessEmail || "you"} when texting is ready.
        </p>
        <p className="tr-small">You can close this page. Nothing else is needed from you.</p>
      </div>,
    );
  }

  if (view.phase === "pin") {
    return shell(
      <div className="tr-center">
        {pinDone ? (
          <>
            <div className="tr-ok" aria-hidden="true">✓</div>
            <h1>Verified</h1>
            <p className="tr-lede">Thank you. {view.displayName}&apos;s registration continues automatically, and we&apos;ll email you when texting is ready.</p>
          </>
        ) : (
          <>
            <h1>Enter the code we texted</h1>
            <p className="tr-lede">We texted a 6-digit code to the owner&apos;s mobile number to confirm {view.displayName}. The code expires 24 hours after it was sent.</p>
            <div className="tr-pin">
              <label htmlFor="tr-pin" className="tr-sr">Code</label>
              <input id="tr-pin" className="tr-input tr-pin-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
              <button type="button" className="tr-btn" disabled={busy || pin.length !== 6} onClick={() => void verifyPin()}>{busy ? "Checking…" : "Verify"}</button>
            </div>
            {pinMessage ? <p className="tr-small" role="status">{pinMessage}</p> : null}
            <button type="button" className="tr-link" disabled={busy} onClick={() => void resendPin()}>Send a new code</button>
          </>
        )}
      </div>,
    );
  }

  const w = view.wording;
  const fixing = !!view.fixFields;

  return shell(
    <form
      className="tr-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1>{fixing ? "One thing to fix" : `Register ${view.displayName} for texting`}</h1>
      <p className="tr-lede">
        {fixing
          ? view.fixNote
          : "US mobile carriers require this 10DLC registration before a business can text customers. Fill in the boxes below. Everything in grey is already done for you."}
      </p>

      <section className="tr-section">
        <h2>Your business</h2>
        <p className="tr-sub">Match your IRS letter (form CP-575) exactly, including LLC or Inc.</p>
        <div className="tr-grid">
          {field("legalName", sole ? "Your full legal name" : "Legal business name", text("legalName", { placeholder: sole ? "e.g. Maria Rivera" : "e.g. Hudson Valley Tire Company LLC", autoComplete: "organization" }), undefined, true)}
          {field(
            "entityType",
            "Business type",
            <ConnectSelect
              id="tr-entityType"
              value={businessKind}
              onChange={(v) => {
                setBusinessKind(v);
                set("entityType", KIND_ENTITY_TYPE);
              }}
              options={BUSINESS_KIND_OPTIONS}
              placeholder={answers.entityType ? "Answered — pick again to change" : "Choose…"}
              disabled={!editable("entityType")}
              ariaLabel="Business type"
            />,
          )}
          {sole
            ? field("mobilePhone", "Owner's mobile number", text("mobilePhone", { inputMode: "tel", placeholder: "(914) 555-0187", autoComplete: "tel" }), "We'll text a code here to confirm it's you.")
            : field(
                "ein",
                "EIN (federal tax ID)",
                <input
                  id="tr-ein"
                  className="tr-input"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={view.einOnFile && !editable("ein") ? "On file" : "12-3456789"}
                  value={ein}
                  disabled={!editable("ein")}
                  onChange={(e) => {
                    setEin(e.target.value.replace(/[^\d-]/g, "").slice(0, 10));
                    setErrors((er) => ({ ...er, ein: "" }));
                  }}
                  aria-invalid={!!errors.ein}
                />,
                "Used only for this registration.",
              )}
          {field("street", "Street address the IRS has on file", text("street", { autoComplete: "street-address", placeholder: "1180 Route 9W" }), "No PO boxes.", true)}
          {field("city", "City", text("city", { autoComplete: "address-level2" }))}
          <div className="tr-row2">
            {field(
              "state",
              "State",
              <ConnectSelect id="tr-state" value={answers.state || ""} onChange={(v) => set("state", v)} options={STATES} placeholder="State" disabled={!editable("state")} ariaLabel="State" />,
            )}
            {field("postalCode", "ZIP", text("postalCode", { inputMode: "numeric", autoComplete: "postal-code", maxLength: 10 }))}
          </div>
          {field("website", "Website, Google Business page or Facebook page", text("website", { inputMode: "url", placeholder: "https://" }), "No website? Paste the link to your Google Business listing or Facebook page.", true)}
        </div>
      </section>

      <section className="tr-section">
        <p className="tr-lockhead"><LockIcon />From your Loopcom account</p>
        <dl className="tr-locked">
          {lockedList?.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="tr-small tr-left">Something wrong here? Call 845-723-1213.</p>
      </section>

      <section className="tr-section">
        <p className="tr-lockhead"><LockIcon />What carriers need, written for you</p>
        <div className="tr-msg"><span className="tr-k">How you&apos;ll use texting</span>{w.description}</div>
        <div className="tr-msg"><span className="tr-k">Example text</span><span className="tr-bubble">{w.sample1}</span></div>
        <div className="tr-msg"><span className="tr-k">When someone replies STOP</span><span className="tr-bubble">{w.optoutMessage}</span></div>
        <details className="tr-more">
          <summary>The rest of the wording</summary>
          <div className="tr-more-inner">
            <div className="tr-msg"><span className="tr-k">How customers agree to texts</span>{w.optinFlow}</div>
            <div className="tr-msg"><span className="tr-k">Second example text</span><span className="tr-bubble">{w.sample2}</span></div>
            <div className="tr-msg"><span className="tr-k">When someone replies HELP</span><span className="tr-bubble">{w.helpMessage}</span></div>
            <div className="tr-msg"><span className="tr-k">When someone replies START</span><span className="tr-bubble">{w.optinMessage}</span></div>
            <div className="tr-msg"><span className="tr-k">Words that stop texts</span>{w.optoutKeywords.split(",").join(", ")}</div>
            <div className="tr-msg">
              <span className="tr-k">Texting privacy policy and terms</span>
              Written in your business&apos;s name and published for you:{" "}
              <a href={view.privacyUrl} target="_blank" rel="noreferrer">privacy policy</a> ·{" "}
              <a href={view.termsUrl} target="_blank" rel="noreferrer">terms</a>
            </div>
          </div>
        </details>
      </section>

      <label className={`tr-consent${errors.consent ? " tr-invalid" : ""}`} htmlFor="tr-consent">
        <input id="tr-consent" type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); setErrors((er) => ({ ...er, consent: "" })); }} />
        <span>I&apos;m authorized to act for this business. The information above is true, and Loopcom LLC may register it with mobile carriers and the industry registry for business texting.</span>
      </label>
      {errors.consent ? <div className="tr-error" role="alert">{errors.consent}</div> : null}

      <div className={`tr-field tr-full${errors.signatureName ? " tr-invalid" : ""}`}>
        <label htmlFor="tr-signatureName">Type your full name to sign<span className="tr-req" aria-hidden="true">*</span></label>
        <input id="tr-signatureName" className="tr-input" value={signature} autoComplete="name" onChange={(e) => { setSignature(e.target.value); setErrors((er) => ({ ...er, signatureName: "" })); }} />
        {errors.signatureName ? <div className="tr-error" role="alert">{errors.signatureName}</div> : null}
      </div>

      {banner ? <div className="tr-banner" role="alert">{banner}</div> : null}
      <button type="submit" className="tr-btn tr-submit" disabled={busy}>{busy ? "Sending…" : fixing ? "Send the fix" : "Send my registration"}</button>
      <p className="tr-small">Your EIN is stored as a secure token, used only for this registration, and deleted once it&apos;s verified.</p>
    </form>,
  );
}
