"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPut, apiPost, getPortalApiBaseUrl } from "../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

type CellMode = "" | "also" | "only";
type Extension = { displayName: string; extNumber: string; email: string; vmPassword: string; cellMode: CellMode; cellNumber: string };

type PortingDetails = {
  carrier: string;
  numbers: string;
  accountNumber: string;
  nameOnAccount: string;
  serviceAddress: string;
  portPin: string;
  loaFileName: string;
  billFileName: string;
};

type AvailableNumber = { number: string; location: string; sms: boolean; voice: boolean; inStock?: boolean };

type FormData = {
  companyName: string;
  firstName: string;
  lastName: string;
  mainPhone: string;
  address: string;
  mainEmail: string;
  billingEmail: string;
  numberChoice: "new" | "port" | "";
  selectedNumber: string;
  porting: PortingDetails;
  extensions: Extension[];
  smsEnabled: boolean;
};

const EMPTY_EXT: Extension = { displayName: "", extNumber: "", email: "", vmPassword: "", cellMode: "", cellNumber: "" };

const EMPTY_FORM: FormData = {
  companyName: "", firstName: "", lastName: "",
  mainPhone: "", address: "", mainEmail: "", billingEmail: "",
  numberChoice: "", selectedNumber: "",
  porting: { carrier: "", numbers: "", accountNumber: "", nameOnAccount: "", serviceAddress: "", portPin: "", loaFileName: "", billFileName: "" },
  extensions: [{ ...EMPTY_EXT }],
  smsEnabled: false,
};

const STEPS = [
  { id: "company",    label: "Company"    },
  { id: "contact",    label: "Contact"    },
  { id: "number",     label: "Your number"},
  { id: "extensions", label: "Extensions" },
  { id: "addons",     label: "Add-ons"    },
  { id: "review",     label: "Review"     },
];

// ── Inline SVG icons ─────────────────────────────────────────────────────────

function IconBuilding() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>); }
function IconContact() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>); }
function IconPhone() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/></svg>); }
function IconExtensions() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="9" width="4" height="6" rx="1"/><rect x="10" y="4" width="4" height="6" rx="1"/><rect x="10" y="14" width="4" height="6" rx="1"/><rect x="18" y="9" width="4" height="6" rx="1"/><path d="M6 12h4M14 7h4v5M14 17h4v-5"/></svg>); }
function IconSms() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>); }
function IconCheck() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>); }
function IconArrowRight({ size = 14 }: { size?: number }) { return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>); }
function IconArrowLeft({ size = 14 }: { size?: number }) { return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8H3M7 4L3 8l4 4"/></svg>); }
function IconTick({ size = 12 }: { size?: number }) { return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 8 7 12 13 4"/></svg>); }
function IconUpload() { return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>); }
function IconSun() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>); }
function IconMoon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>); }

// ── Validation helpers ───────────────────────────────────────────────────────

function isEmail(v: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); }
function isNumericExt(v: string) { return /^\d+$/.test(v.trim()); }

function validateStep(step: number, f: FormData): string | null {
  if (step === 0) {
    if (f.companyName.trim().length < 2) return "Company name must be at least 2 characters.";
    if (f.firstName.trim().length < 1) return "First name is required.";
    if (f.lastName.trim().length < 1) return "Last name is required.";
  }
  if (step === 1) {
    if (f.mainPhone.trim().length < 7) return "A valid phone number is required.";
    if (f.address.trim().length < 3) return "Service address is required.";
    if (!isEmail(f.mainEmail)) return "A valid main email is required.";
    // Billing email is optional — when blank we bill to the main email.
    if (f.billingEmail.trim() && !isEmail(f.billingEmail)) return "The billing email doesn't look right — fix it or leave it blank.";
  }
  if (step === 2) {
    if (!f.numberChoice) return "Please choose how you'd like to set up your number.";
    if (f.numberChoice === "new" && !f.selectedNumber) return "Please pick a number from the list.";
    if (f.numberChoice === "port") {
      if (f.porting.numbers.trim().length < 7) return "Enter the number you'd like to bring over.";
      if (f.porting.carrier.trim().length < 2) return "Your current carrier is required.";
      if (f.porting.accountNumber.trim().length < 1) return "Your carrier account number is required.";
    }
  }
  if (step === 3) {
    for (const ext of f.extensions) {
      if (ext.displayName.trim().length < 1) return "Each extension needs a name.";
      if (!isNumericExt(ext.extNumber)) return `Extension number "${ext.extNumber || "(empty)"}" must be numeric.`;
      if (ext.cellMode && ext.cellNumber.replace(/\D/g, "").replace(/^1/, "").length !== 10) {
        return `Enter a full cell phone number for ${ext.displayName.trim() || "extension " + (ext.extNumber || "?")}.`;
      }
      // Email is optional, but a typed one must be valid — catching it here
      // instead of letting the final submit reject it on the review step.
      if (ext.email.trim() && !isEmail(ext.email)) {
        return `The email for ${ext.displayName.trim() || "extension " + (ext.extNumber || "?")} doesn't look right — fix it or leave it blank.`;
      }
    }
    const nums = f.extensions.map((e) => e.extNumber.trim());
    if (new Set(nums).size !== nums.length) return "Extension numbers must be unique.";
  }
  return null;
}

function areaCodeFrom(phone: string): string {
  const d = phone.replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return t.slice(0, 3);
}

// ── Main component ───────────────────────────────────────────────────────────

export default function PublicOnboardingPage({ params }: { params: { token: string } }) {
  const token = params.token;

  const [loading, setLoading] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);

  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Number search state
  const [numbers, setNumbers] = useState<AvailableNumber[]>([]);
  const [numbersLoading, setNumbersLoading] = useState(false);
  const [numbersQuery, setNumbersQuery] = useState("");
  const [numbersError, setNumbersError] = useState<string | null>(null);

  // Porting: portability check + document uploads
  const [portability, setPortability] = useState<"idle" | "checking" | "portable" | "unknown">("idle");
  const [uploading, setUploading] = useState<{ loa: boolean; bill: boolean }>({ loa: false, bill: false });

  // ── Token validation ──────────────────────────────────────────────────────
  useEffect(() => {
    async function validate() {
      try {
        const r = await apiGet<{ ok: boolean; exists?: boolean; submission?: { id: string; currentStep: number | string | null; answers: any } }>(
          `/onboarding/${encodeURIComponent(token)}/validate`,
        );
        if (r.exists === false) { setTokenError("not_active"); return; }
        const a = r.submission?.answers || {};
        if (a.submit || a.company || a.contact || a.phone || a.extensions || a.addons) {
          setForm((prev) => ({
            ...prev,
            companyName:   a.submit?.companyName   || a.company?.companyName   || prev.companyName,
            firstName:     a.submit?.firstName     || a.company?.firstName     || prev.firstName,
            lastName:      a.submit?.lastName      || a.company?.lastName      || prev.lastName,
            mainPhone:     a.submit?.mainPhone     || a.contact?.mainPhone     || prev.mainPhone,
            address:       a.submit?.address       || a.contact?.address       || prev.address,
            mainEmail:     a.submit?.mainEmail     || a.contact?.mainEmail     || prev.mainEmail,
            billingEmail:  a.submit?.billingEmail  || a.contact?.billingEmail  || prev.billingEmail,
            numberChoice:  a.phone?.choice         || prev.numberChoice,
            selectedNumber:a.phone?.selectedNumber || prev.selectedNumber,
            porting:       { ...prev.porting, ...(a.phone?.details || {}) },
            extensions:    Array.isArray(a.extensions) && a.extensions.length ? a.extensions.map((e: any) => ({ ...EMPTY_EXT, ...e })) : prev.extensions,
            smsEnabled:    a.addons?.smsEnabled    ?? prev.smsEnabled,
          }));
        }
        // The API stores the step as a string — parse either form.
        const savedStep = Number(r.submission?.currentStep ?? 0) || 0;
        if (savedStep > 0 && savedStep < STEPS.length) setStep(savedStep);
      } catch {
        setTokenError("not_active");
      } finally {
        setLoading(false);
      }
    }
    validate();
  }, [token]);

  // ── Autosave ────────────────────────────────────────────────────────────────
  const scheduleAutosave = useCallback((f: FormData, currentStep: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      try {
        await apiPut(`/onboarding/${encodeURIComponent(token)}/save`, {
          currentStep,
          answers: {
            company:    { companyName: f.companyName, firstName: f.firstName, lastName: f.lastName },
            contact:    { mainPhone: f.mainPhone, address: f.address, mainEmail: f.mainEmail, billingEmail: f.billingEmail },
            phone:      { choice: f.numberChoice, selectedNumber: f.selectedNumber, details: f.porting },
            extensions: f.extensions,
            addons:     { smsEnabled: f.smsEnabled },
          },
        });
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2500);
      } catch {
        setSaveState("idle");
      }
    }, 900);
  }, [token]);

  function updateForm(patch: Partial<FormData>) {
    setForm((prev) => { const next = { ...prev, ...patch }; scheduleAutosave(next, step); return next; });
    setStepError(null);
  }

  // ── Number search ─────────────────────────────────────────────────────────
  const searchNumbers = useCallback(async (query: string) => {
    setNumbersLoading(true);
    setNumbersError(null);
    try {
      // VoIP.ms availability search regularly takes 15-25s — far beyond the
      // client's default 10s timeout, which made this look like "no numbers".
      const r = await apiGet<{ numbers?: AvailableNumber[] }>(
        `/onboarding/${encodeURIComponent(token)}/numbers?q=${encodeURIComponent(query)}`,
        undefined,
        { timeoutMs: 45_000 },
      );
      setNumbers(Array.isArray(r.numbers) ? r.numbers : []);
    } catch {
      setNumbers([]);
      setNumbersError("We couldn't load available numbers just now. Try another area code, or continue and we'll assign one.");
    } finally {
      setNumbersLoading(false);
    }
  }, [token]);

  // Auto-search when the customer chooses "new number".
  useEffect(() => {
    if (step === 2 && form.numberChoice === "new" && numbers.length === 0 && !numbersLoading && !numbersError) {
      const seed = areaCodeFrom(form.mainPhone) || "";
      setNumbersQuery(seed);
      searchNumbers(seed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form.numberChoice]);

  // Debounced portability check when the customer is porting a number in.
  useEffect(() => {
    if (step !== 2 || form.numberChoice !== "port") return;
    const digits = form.porting.numbers.replace(/\D/g, "");
    if (digits.length < 10) { setPortability("idle"); return; }
    let cancelled = false;
    setPortability("checking");
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<{ portable: boolean | null }>(
          `/onboarding/${encodeURIComponent(token)}/portability?number=${encodeURIComponent(digits)}`,
          undefined,
          { timeoutMs: 30_000 },
        );
        if (!cancelled) setPortability(r.portable === true ? "portable" : "unknown");
      } catch {
        if (!cancelled) setPortability("unknown");
      }
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.porting.numbers, form.numberChoice, step]);

  async function uploadPortDoc(kind: "loa" | "bill", file: File) {
    setStepError(null);
    setUploading((u) => ({ ...u, [kind]: true }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${getPortalApiBaseUrl()}/onboarding/${encodeURIComponent(token)}/upload-bill?kind=${kind}`, { method: "POST", body: fd, cache: "no-store" });
      if (!res.ok) throw new Error("upload_failed");
      updateForm({ porting: { ...form.porting, [kind === "loa" ? "loaFileName" : "billFileName"]: file.name } });
    } catch {
      setStepError("That file couldn't upload. Please check the file and try again.");
    } finally {
      setUploading((u) => ({ ...u, [kind]: false }));
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function goNext() {
    const err = validateStep(step, form);
    if (err) { setStepError(err); return; }
    setStepError(null);
    // Leaving the number step: start setting up their number in the background
    // (buy / route / temporary number for ports). Fire-and-forget — the customer
    // keeps moving through the wizard while it happens.
    if (step === 2) {
      void apiPost(`/onboarding/${encodeURIComponent(token)}/apply-number`, {
        choice: form.numberChoice,
        selectedNumber: form.numberChoice === "new" ? form.selectedNumber : undefined,
        porting: form.numberChoice === "port" ? form.porting : undefined,
        smsEnabled: form.smsEnabled,
        companyName: form.companyName,
      }).catch(() => { /* retried on final submit */ });
    }
    const next = step + 1;
    setStep(next);
    scheduleAutosave(form, next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function goBack() { setStepError(null); setStep((s) => Math.max(0, s - 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setSubmitError(null);
    // Re-check every step before launching: autosaved data can predate newer
    // validation, and fields edited on earlier steps shouldn't fail server-side.
    for (let s = 0; s <= 3; s++) {
      const err = validateStep(s, form);
      if (err) { setSubmitError(err); return; }
    }
    setSubmitting(true);
    try {
      await apiPost(`/onboarding/${encodeURIComponent(token)}/submit`, {
        companyName:        form.companyName,
        contactFirstName:   form.firstName,
        contactLastName:    form.lastName,
        address:            form.address,
        mainPhone:          form.mainPhone,
        mainEmail:          form.mainEmail,
        // No separate billing contact? Bills go to the main email.
        billingEmail:       form.billingEmail.trim() || form.mainEmail,
        phoneNumberChoice:  form.numberChoice || undefined,
        selectedNumber:     form.numberChoice === "new" ? form.selectedNumber || undefined : undefined,
        porting:            form.numberChoice === "port" ? form.porting : undefined,
        smsEnabled:         form.smsEnabled,
        extensions:         form.extensions
          .filter((e) => e.displayName.trim() && e.extNumber.trim())
          .map((e) => ({
            displayName: e.displayName.trim(),
            extNumber: e.extNumber.trim(),
            email: e.email.trim() || undefined,
            vmPassword: e.vmPassword.trim() || undefined,
            cellMode: e.cellMode || undefined,
            cellNumber: e.cellMode ? e.cellNumber.replace(/\D/g, "").replace(/^1/, "") : undefined,
          })),
      });
      window.location.href = `/onboarding/${encodeURIComponent(token)}/success`;
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("write_blocked") || msg.includes("already been submitted")) {
        setSubmitError("This form has already been submitted. Contact your Connect Communications representative for a new link.");
      } else {
        setSubmitError(msg || "Submission failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Extension + upload + theme helpers ────────────────────────────────────
  function addExt() { updateForm({ extensions: [...form.extensions, { ...EMPTY_EXT }] }); }
  function removeExt(i: number) { updateForm({ extensions: form.extensions.filter((_, idx) => idx !== i) }); }
  function updateExt(i: number, patch: Partial<Extension>) { updateForm({ extensions: form.extensions.map((e, idx) => idx === i ? { ...e, ...patch } : e) }); }

  function toggleTheme() {
    const shell = document.querySelector(".ob-shell");
    if (!shell) return;
    const cur = shell.getAttribute("data-ob-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    shell.setAttribute("data-ob-theme", next);
    try { window.localStorage.setItem("ob-theme", next); } catch { /* ignore */ }
    setThemeLabel(next);
  }
  const [themeLabel, setThemeLabel] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const shell = document.querySelector(".ob-shell");
    const cur = shell?.getAttribute("data-ob-theme");
    if (cur === "light" || cur === "dark") setThemeLabel(cur);
    else setThemeLabel(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, [loading]);

  // ── Render guards ─────────────────────────────────────────────────────────
  if (loading) {
    return (<div className="ob-loading"><div className="ob-spinner" /><span>Loading your setup…</span></div>);
  }
  if (tokenError) {
    return (
      <div className="ob-invalid-wrap">
        <div className="ob-invalid-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div className="ob-invalid-title">This onboarding link is not active</div>
        <p className="ob-invalid-body">Please contact your Connect Communications contact for a new link.</p>
        <p className="ob-invalid-support">Need help? <a href="mailto:support@connectcomunications.com" className="ob-invalid-link">support@connectcomunications.com</a></p>
      </div>
    );
  }

  const stepIcons = [IconBuilding, IconContact, IconPhone, IconExtensions, IconSms, IconCheck];
  const StepIcon = stepIcons[step] ?? IconCheck;
  const eyebrows = ["About you", "Reach you", "Your number", "Your team", "Extras", "Confirm"];
  const stepTitles = ["Tell us about your company", "How can we reach you?", "Choose your phone number", "Add your team's extensions", "Business messaging", "Review & launch"];
  const stepSubtitles = [
    "We'll use this to build your account and phone system.",
    "Your billing contact can be different from your main contact.",
    "Bring your existing number, or grab a fresh one — set up instantly.",
    "Each person gets their own extension. We create them all automatically.",
    "Turn on texting for your business number — you can change this anytime.",
    "Here's everything. When you launch, your system builds itself in the background.",
  ];

  return (
    <>
      {/* Header */}
      <div className="ob-header">
        <div className="ob-logo">
          <div className="ob-logo-mark">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3" fill="rgba(255,255,255,0.95)"/>
              <circle cx="3" cy="5" r="1.5" fill="rgba(255,255,255,0.6)"/><circle cx="13" cy="5" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <circle cx="3" cy="11" r="1.5" fill="rgba(255,255,255,0.6)"/><circle cx="13" cy="11" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <line x1="8" y1="8" x2="3" y2="5" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/><line x1="8" y1="8" x2="13" y2="5" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
              <line x1="8" y1="8" x2="3" y2="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/><line x1="8" y1="8" x2="13" y2="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
            </svg>
          </div>
          <span className="ob-logo-text">Connect</span>
        </div>
        <div className="ob-header-tools">
          <div className="ob-save-indicator" style={{ opacity: saveState !== "idle" ? 1 : 0 }}>
            {saveState === "saving"
              ? (<><div className="ob-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /><span>Saving…</span></>)
              : (<><div className="ob-save-dot" /><span>Saved</span></>)}
          </div>
          <button className="ob-theme-toggle" onClick={toggleTheme} aria-label="Toggle light or dark theme">
            {themeLabel === "dark" ? <IconMoon /> : <IconSun />} {themeLabel === "dark" ? "Dark" : "Light"}
          </button>
        </div>
      </div>

      {/* Progress */}
      <div className="ob-progress">
        <div className="ob-progress-track">
          {STEPS.map((s, i) => (<div key={s.id} className={`ob-progress-step${i < step ? " done" : i === step ? " active" : ""}`} />))}
        </div>
        <div className="ob-progress-label">
          <span className="ob-progress-label-current">{STEPS[step]?.label}</span>
          <span>Step {step + 1} of {STEPS.length}</span>
        </div>
      </div>

      {/* Card */}
      <div className="ob-card" key={step}>
        <div className="ob-illustration"><StepIcon /></div>
        <div className="ob-step-eyebrow">{eyebrows[step]}</div>
        <h1 className="ob-step-title">{stepTitles[step]}</h1>
        <p className="ob-step-subtitle">{stepSubtitles[step]}</p>

        {/* Step 0: Company */}
        {step === 0 && (
          <div>
            <div className="ob-field">
              <label className="ob-label">Company name</label>
              <input className="ob-input" placeholder="Acme Corp" value={form.companyName} onChange={(e) => updateForm({ companyName: e.target.value })} />
            </div>
            <div className="ob-field-row">
              <div><label className="ob-label">First name</label><input className="ob-input" placeholder="Jane" value={form.firstName} onChange={(e) => updateForm({ firstName: e.target.value })} /></div>
              <div><label className="ob-label">Last name</label><input className="ob-input" placeholder="Smith" value={form.lastName} onChange={(e) => updateForm({ lastName: e.target.value })} /></div>
            </div>
          </div>
        )}

        {/* Step 1: Contact */}
        {step === 1 && (
          <div>
            <div className="ob-field"><label className="ob-label">Main phone number</label><input className="ob-input" placeholder="(555) 000-0000" value={form.mainPhone} onChange={(e) => updateForm({ mainPhone: e.target.value })} /></div>
            <div className="ob-field">
              <label className="ob-label">Service address</label>
              <input className="ob-input" placeholder="123 Main St, City, State 00000" value={form.address} onChange={(e) => updateForm({ address: e.target.value })} />
              <div className="ob-field-hint">Used for 911 registration and number provisioning.</div>
            </div>
            <div className="ob-field-row">
              <div><label className="ob-label">Primary email</label><input className="ob-input" type="email" placeholder="jane@acme.com" value={form.mainEmail} onChange={(e) => updateForm({ mainEmail: e.target.value })} /></div>
              <div><label className="ob-label">Billing email<span className="ob-label-optional">optional</span></label><input className="ob-input" type="email" placeholder="billing@acme.com" value={form.billingEmail} onChange={(e) => updateForm({ billingEmail: e.target.value })} /></div>
            </div>
          </div>
        )}

        {/* Step 2: Your number */}
        {step === 2 && (
          <div>
            <div className="ob-choice-group" style={{ marginBottom: form.numberChoice ? 20 : 0 }}>
              <div className={`ob-choice${form.numberChoice === "new" ? " selected" : ""}`} tabIndex={0} onClick={() => updateForm({ numberChoice: "new" })}
                onKeyDown={(e) => e.key === "Enter" && updateForm({ numberChoice: "new" })}>
                <div className="ob-choice-radio"><div className="ob-choice-radio-dot" /></div>
                <div className="ob-choice-body"><div className="ob-choice-label">Get a new number</div><div className="ob-choice-desc">Pick a local number and it's live in minutes.</div></div>
                <div className="ob-choice-badge">Instant</div>
              </div>
              <div className={`ob-choice${form.numberChoice === "port" ? " selected" : ""}`} tabIndex={0} onClick={() => updateForm({ numberChoice: "port" })}
                onKeyDown={(e) => e.key === "Enter" && updateForm({ numberChoice: "port" })}>
                <div className="ob-choice-radio"><div className="ob-choice-radio-dot" /></div>
                <div className="ob-choice-body"><div className="ob-choice-label">Bring my existing number</div><div className="ob-choice-desc">Keep the number you have — we handle the whole transfer.</div></div>
              </div>
            </div>

            {/* New number: search + pick */}
            {form.numberChoice === "new" && (
              <div>
                <label className="ob-label">Search by area code or city</label>
                <div className="ob-searchbar">
                  <input className="ob-input" placeholder="e.g. 305 or Miami" value={numbersQuery}
                    onChange={(e) => setNumbersQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchNumbers(numbersQuery)} />
                  <button className="ob-btn-ghost" onClick={() => searchNumbers(numbersQuery)}>Search</button>
                </div>
                {numbersLoading && <div className="ob-field-hint">Finding available numbers… this can take up to 30 seconds.</div>}
                {numbersError && <div className="ob-field-hint">{numbersError}</div>}
                {!numbersLoading && numbers.length > 0 && (
                  <>
                    <div className="ob-num-grid">
                      {numbers.map((n) => (
                        <div key={n.number} className={`ob-num${form.selectedNumber === n.number ? " selected" : ""}`} tabIndex={0}
                          onClick={() => updateForm({ selectedNumber: n.number })} onKeyDown={(e) => e.key === "Enter" && updateForm({ selectedNumber: n.number })}>
                          <div>
                            <div className="ob-num-n">{n.number}</div>
                            {n.location && <div className="ob-num-loc">{n.location}</div>}
                            <div className="ob-caps">{n.inStock && <span className="ob-cap ob-cap-stock">Ready now</span>}{n.voice && <span className="ob-cap">Voice</span>}{n.sms && <span className="ob-cap">SMS</span>}</div>
                          </div>
                          <div className="ob-num-tick"><IconTick /></div>
                        </div>
                      ))}
                    </div>
                    {form.selectedNumber && <div className="ob-field-hint" style={{ marginTop: 12 }}>Selected: <b>{form.selectedNumber}</b></div>}
                  </>
                )}
              </div>
            )}

            {/* Port existing */}
            {form.numberChoice === "port" && (
              <>
                {portability === "checking" && (
                  <div className="ob-field-hint" style={{ marginBottom: 14 }}>Checking whether this number can be transferred…</div>
                )}
                {portability === "portable" && (
                  <div className="ob-port-check">
                    <div className="ob-port-check-ok"><IconTick /></div>
                    <div><b>{form.porting.numbers} can be transferred</b> <span>· typically 3–5 business days</span></div>
                  </div>
                )}
              <div className="ob-porting-details">
                <div className="ob-step-eyebrow" style={{ marginBottom: 14 }}>Details from your current carrier</div>
                <div className="ob-field-row">
                  <div><label className="ob-label">Number to bring over</label><input className="ob-input" placeholder="(555) 000-0000" value={form.porting.numbers} onChange={(e) => updateForm({ porting: { ...form.porting, numbers: e.target.value } })} /></div>
                  <div><label className="ob-label">Current carrier</label><input className="ob-input" placeholder="AT&T, Spectrum…" value={form.porting.carrier} onChange={(e) => updateForm({ porting: { ...form.porting, carrier: e.target.value } })} /></div>
                </div>
                <div className="ob-field-row">
                  <div><label className="ob-label">Account number</label><input className="ob-input" placeholder="Account #" value={form.porting.accountNumber} onChange={(e) => updateForm({ porting: { ...form.porting, accountNumber: e.target.value } })} /></div>
                  <div><label className="ob-label">Porting PIN<span className="ob-label-optional">if any</span></label><input className="ob-input" placeholder="PIN" value={form.porting.portPin} onChange={(e) => updateForm({ porting: { ...form.porting, portPin: e.target.value } })} /></div>
                </div>
                <div className="ob-field"><label className="ob-label">Name on account</label><input className="ob-input" placeholder="As it appears on your phone bill" value={form.porting.nameOnAccount} onChange={(e) => updateForm({ porting: { ...form.porting, nameOnAccount: e.target.value } })} /></div>
                <div className="ob-field" style={{ marginBottom: 0 }}><label className="ob-label">Service address on the bill</label><input className="ob-input" placeholder="Billing address on your current carrier account" value={form.porting.serviceAddress} onChange={(e) => updateForm({ porting: { ...form.porting, serviceAddress: e.target.value } })} /></div>
                <div className="ob-uploads">
                  <label className={`ob-upl${form.porting.loaFileName ? " done" : ""}`}>
                    <input type="file" accept="application/pdf,image/*" style={{ display: "none" }} disabled={uploading.loa}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPortDoc("loa", f); }} />
                    <div className="ob-upl-ic">{uploading.loa ? <div className="ob-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /> : form.porting.loaFileName ? <IconTick size={20} /> : <IconUpload />}</div>
                    <b>{form.porting.loaFileName ? "Authorization added" : "Signed authorization"}</b>
                    <span>{uploading.loa ? "Uploading…" : form.porting.loaFileName || "PDF or photo"}</span>
                  </label>
                  <label className={`ob-upl${form.porting.billFileName ? " done" : ""}`}>
                    <input type="file" accept="application/pdf,image/*" style={{ display: "none" }} disabled={uploading.bill}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPortDoc("bill", f); }} />
                    <div className="ob-upl-ic">{uploading.bill ? <div className="ob-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /> : form.porting.billFileName ? <IconTick size={20} /> : <IconUpload />}</div>
                    <b>{form.porting.billFileName ? "Bill added" : "Recent phone bill"}</b>
                    <span>{uploading.bill ? "Uploading…" : form.porting.billFileName || "PDF or photo"}</span>
                  </label>
                </div>
                <div className="ob-field-hint" style={{ marginTop: 12 }}>Your number keeps working until the transfer completes — typically 3–5 business days.</div>
              </div>
              </>
            )}
          </div>
        )}

        {/* Step 3: Extensions */}
        {step === 3 && (
          <div>
            <table className="ob-ext-table">
              <thead><tr><th>Name</th><th>Ext #</th><th>Email <span className="ob-label-optional">optional</span></th><th /></tr></thead>
              <tbody>
                {form.extensions.map((ext, i) => (
                  <Fragment key={i}>
                    <tr className="ob-ext-row">
                      <td><input className="ob-input" placeholder="Jane Smith" value={ext.displayName} onChange={(e) => updateExt(i, { displayName: e.target.value })} /></td>
                      <td><input className="ob-input" placeholder="101" value={ext.extNumber} onChange={(e) => updateExt(i, { extNumber: e.target.value.replace(/\D/g, "") })} style={{ textAlign: "center" }} /></td>
                      <td><input className="ob-input" type="email" placeholder="jane@acme.com" value={ext.email} onChange={(e) => updateExt(i, { email: e.target.value })} /></td>
                      <td>{form.extensions.length > 1 && (<button className="ob-ext-remove" onClick={() => removeExt(i)} title="Remove">×</button>)}</td>
                    </tr>
                    <tr className="ob-ext-cell-row">
                      <td colSpan={4}>
                        <div className="ob-ext-cell">
                          <select
                            className="ob-input ob-ext-cell-select"
                            value={ext.cellMode}
                            onChange={(e) => updateExt(i, { cellMode: e.target.value as CellMode, cellNumber: e.target.value ? ext.cellNumber : "" })}
                          >
                            <option value="">Rings their desk phone &amp; app</option>
                            <option value="also">Also rings their cell phone</option>
                            <option value="only">Goes straight to their cell phone</option>
                          </select>
                          {ext.cellMode && (
                            <input
                              className="ob-input ob-ext-cell-input"
                              placeholder="Cell number — (555) 000-0000"
                              value={ext.cellNumber}
                              onChange={(e) => updateExt(i, { cellNumber: e.target.value })}
                            />
                          )}
                        </div>
                        {ext.cellMode && (
                          <div className="ob-field-hint" style={{ marginTop: 6 }}>
                            {ext.cellMode === "also"
                              ? "Calls to this extension will ring the desk phone, the app, and this cell number at the same time."
                              : "Calls to this extension will go straight to this cell number."}
                          </div>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            <button className="ob-ext-add" onClick={addExt}>+ Add another extension</button>
            <div className="ob-callout">
              <IconCheck />
              <span>These are created on your phone system <b className="ob-auto">automatically</b> the moment you launch — no files to upload, no waiting.</span>
            </div>
          </div>
        )}

        {/* Step 4: Add-ons */}
        {step === 4 && (
          <div>
            <div className={`ob-toggle-row${form.smsEnabled ? " on" : ""}`} onClick={() => updateForm({ smsEnabled: !form.smsEnabled })} style={{ cursor: "pointer" }}>
              <div className="ob-toggle-info">
                <div className="ob-toggle-title">Business SMS messaging</div>
                <div className="ob-toggle-desc">Send &amp; receive texts from your business number, right from Connect.</div>
              </div>
              <label className="ob-toggle-switch" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={form.smsEnabled} onChange={(e) => updateForm({ smsEnabled: e.target.checked })} />
                <span className="ob-toggle-track" />
              </label>
            </div>
            <div className="ob-field-hint" style={{ marginTop: 13 }}>Turn it on now or later from your account — either way it's ready on day one.</div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 5 && (
          <div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Company</div>
              <div className="ob-review-row"><span className="ob-review-key">Company</span><span className="ob-review-val">{form.companyName}</span></div>
              <div className="ob-review-row"><span className="ob-review-key">Contact</span><span className="ob-review-val">{form.firstName} {form.lastName}</span></div>
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Contact details</div>
              <div className="ob-review-row"><span className="ob-review-key">Phone</span><span className="ob-review-val">{form.mainPhone}</span></div>
              <div className="ob-review-row"><span className="ob-review-key">Address</span><span className="ob-review-val">{form.address}</span></div>
              <div className="ob-review-row"><span className="ob-review-key">Email</span><span className="ob-review-val">{form.mainEmail}</span></div>
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Your number</div>
              <div className="ob-review-row">
                <span className="ob-review-key">{form.numberChoice === "port" ? "Porting in" : "New number"}</span>
                <span className="ob-review-val">{form.numberChoice === "port" ? (form.porting.numbers || "—") : (form.selectedNumber || "—")}</span>
              </div>
              <div className="ob-review-row"><span className="ob-review-key">Server</span><span className="ob-review-val">New York 1{form.smsEnabled ? " · SMS on" : ""}</span></div>
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Extensions ({form.extensions.filter((e) => e.extNumber).length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {form.extensions.filter((e) => e.extNumber).map((e, i) => (
                  <div key={i} className="ob-review-ext-chip">
                    <span className="ob-review-ext-num">{e.extNumber}</span>
                    {e.displayName}
                    {e.cellMode && <span className="ob-review-ext-cell">{e.cellMode === "only" ? "→ cell" : "+ cell"}</span>}
                  </div>
                ))}
              </div>
              {(() => {
                const filled = form.extensions.filter((e) => e.extNumber.trim());
                const missing = filled.filter((e) => !e.email.trim());
                if (!filled.length || !missing.length) return null;
                return (
                  <div className="ob-warn">
                    {missing.length === filled.length
                      ? "No email addresses were entered, so nobody on your team will receive their login details. Go back to \u201CYour team\u201D and add an email for each person who needs access."
                      : `Extension${missing.length > 1 ? "s" : ""} ${missing.map((e) => e.extNumber).join(", ")} ${missing.length > 1 ? "have" : "has"} no email — ${missing.length > 1 ? "those people" : "that person"} won\u2019t receive login details.`}
                  </div>
                );
              })()}
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Add-ons</div>
              <div className="ob-review-row"><span className="ob-review-key">SMS messaging</span><span className={`ob-review-val${form.smsEnabled ? " ob-auto" : ""}`}>{form.smsEnabled ? "Enabled" : "Not added"}</span></div>
            </div>
            <div className="ob-callout">
              <span>On launch, Connect builds your tenant, creates every extension from your list, {form.numberChoice === "port" ? "ports" : "buys & wires"} your number, and sets your routing — <b className="ob-auto">all automatically</b>.</span>
            </div>
            {submitError && <div className="ob-error">{submitError}</div>}
          </div>
        )}

        {stepError && <div className="ob-error">{stepError}</div>}

        {/* Navigation */}
        <div className="ob-actions">
          {step > 0 ? (<button className="ob-btn-back" onClick={goBack}><IconArrowLeft /> Back</button>) : <div />}
          {step < STEPS.length - 1 ? (
            <button className="ob-btn-next" onClick={goNext}>Continue <IconArrowRight /></button>
          ) : (
            <button className="ob-btn-next ob-btn-submit" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Launching…" : "Launch my phone system"}{!submitting && <IconArrowRight />}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
