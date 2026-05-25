"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPut, apiPost } from "../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

type Extension = { displayName: string; extNumber: string; email: string };

type PortingDetails = {
  carrier: string;
  numbers: string;
  accountNumber: string;
  nameOnAccount: string;
  serviceAddress: string;
  portPin: string;
};

type FormData = {
  companyName: string;
  firstName: string;
  lastName: string;
  mainPhone: string;
  address: string;
  mainEmail: string;
  billingEmail: string;
  numberChoice: "new" | "port" | "unsure" | "";
  provideNow: boolean;
  porting: PortingDetails;
  extensions: Extension[];
  smsEnabled: boolean;
};

const EMPTY_EXT: Extension = { displayName: "", extNumber: "", email: "" };

const EMPTY_FORM: FormData = {
  companyName: "", firstName: "", lastName: "",
  mainPhone: "", address: "", mainEmail: "", billingEmail: "",
  numberChoice: "", provideNow: false,
  porting: { carrier: "", numbers: "", accountNumber: "", nameOnAccount: "", serviceAddress: "", portPin: "" },
  extensions: [{ ...EMPTY_EXT }],
  smsEnabled: false,
};

const STEPS = [
  { id: "welcome",    label: "Company"   },
  { id: "contact",    label: "Contact"   },
  { id: "phone",      label: "Phone"     },
  { id: "extensions", label: "Extensions"},
  { id: "addons",     label: "Add-ons"   },
  { id: "review",     label: "Review"    },
];

// ── Inline SVG telecom motifs ────────────────────────────────────────────────

function IconBuilding() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>
    </svg>
  );
}

function IconContact() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  );
}

function IconPhone() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.8 19.8 0 01.01 1.18 2 2 0 012 0h3a2 2 0 012 1.72 12.8 12.8 0 00.7 2.81 2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.8 12.8 0 002.81.7A2 2 0 0122 14v2.92z" transform="scale(0.9) translate(1.2,1.2)"/>
    </svg>
  );
}

function IconExtensions() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="9" width="4" height="6" rx="1"/>
      <rect x="10" y="4" width="4" height="6" rx="1"/>
      <rect x="10" y="14" width="4" height="6" rx="1"/>
      <rect x="18" y="9" width="4" height="6" rx="1"/>
      <path d="M6 12h4M14 7h4v5M14 17h4v-5"/>
    </svg>
  );
}

function IconSms() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function IconArrowRight({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4"/>
    </svg>
  );
}

function IconArrowLeft({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 8H3M7 4L3 8l4 4"/>
    </svg>
  );
}

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
    if (!isEmail(f.billingEmail)) return "A valid billing email is required.";
  }
  if (step === 2) {
    if (!f.numberChoice) return "Please select a phone number option.";
  }
  if (step === 3) {
    for (const ext of f.extensions) {
      if (ext.displayName.trim().length < 1) return "Each extension needs a name.";
      if (!isNumericExt(ext.extNumber)) return `Extension number "${ext.extNumber || "(empty)"}" must be numeric.`;
    }
    const nums = f.extensions.map((e) => e.extNumber.trim());
    if (new Set(nums).size !== nums.length) return "Extension numbers must be unique.";
  }
  return null;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function PublicOnboardingPage({ params }: { params: { token: string } }) {
  const token = params.token;

  const [loading, setLoading] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);

  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Token validation ────────────────────────────────────────────────────
  useEffect(() => {
    async function validate() {
      try {
        const r = await apiGet<{ exists?: boolean; submission?: { id: string; currentStep: number; answers: any } }>(
          `/onboarding/${encodeURIComponent(token)}/validate`,
        );
        // Guard: link not found or not active
        if (r.exists !== true) {
          setTokenError("not_active");
          return;
        }
        setSubmissionId(r.submission?.id || null);
        // Restore saved answers if any
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
            smsEnabled:    a.addons?.smsEnabled    ?? prev.smsEnabled,
          }));
        }
        const savedStep = typeof r.submission?.currentStep === "number" ? r.submission.currentStep : 0;
        if (savedStep > 0 && savedStep < STEPS.length) setStep(savedStep);
      } catch {
        setTokenError("not_active");
      } finally {
        setLoading(false);
      }
    }
    validate();
  }, [token]);

  // ── Autosave ────────────────────────────────────────────────────────────
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
            phone:      { choice: f.numberChoice, provideNow: f.provideNow, details: f.porting },
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
    setForm((prev) => {
      const next = { ...prev, ...patch };
      scheduleAutosave(next, step);
      return next;
    });
    setStepError(null);
  }

  // ── Navigation ──────────────────────────────────────────────────────────
  function goNext() {
    const err = validateStep(step, form);
    if (err) { setStepError(err); return; }
    setStepError(null);
    const next = step + 1;
    setStep(next);
    scheduleAutosave(form, next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBack() {
    setStepError(null);
    setStep((s) => Math.max(0, s - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiPost(`/onboarding/${encodeURIComponent(token)}/submit`, {
        companyName:       form.companyName,
        contactFirstName:  form.firstName,
        contactLastName:   form.lastName,
        address:      form.address,
        mainPhone:    form.mainPhone,
        mainEmail:    form.mainEmail,
        billingEmail: form.billingEmail,
        smsEnabled:   form.smsEnabled,
        extensions:   form.extensions
          .filter((e) => e.displayName.trim() && e.extNumber.trim())
          .map((e) => ({ displayName: e.displayName.trim(), extNumber: e.extNumber.trim(), email: e.email.trim() || undefined })),
        porting: form.numberChoice === "port" ? {
          choice:     "port",
          provideNow: form.provideNow,
          details:    form.provideNow ? form.porting : undefined,
        } : { choice: form.numberChoice || "new" },
      });
      window.location.href = `/onboarding/${encodeURIComponent(token)}/success`;
    } catch (e: any) {
      setSubmitError(e?.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Extension helpers ────────────────────────────────────────────────────
  function addExt() {
    updateForm({ extensions: [...form.extensions, { ...EMPTY_EXT }] });
  }

  function removeExt(i: number) {
    updateForm({ extensions: form.extensions.filter((_, idx) => idx !== i) });
  }

  function updateExt(i: number, patch: Partial<Extension>) {
    const next = form.extensions.map((e, idx) => idx === i ? { ...e, ...patch } : e);
    updateForm({ extensions: next });
  }

  // ── Render guards ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="ob-loading">
        <div className="ob-spinner" />
        <span>Loading your onboarding…</span>
      </div>
    );
  }

  if (tokenError) {
    return (
      <div className="ob-invalid-wrap">
        <div className="ob-invalid-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div className="ob-invalid-title">This onboarding link is not active</div>
        <p className="ob-invalid-body">
          Please contact your Connect Communications contact for a new link.
        </p>
        <p className="ob-invalid-support">
          Need help?{" "}
          <a href="mailto:support@connectcomunications.com" className="ob-invalid-link">
            support@connectcomunications.com
          </a>
        </p>
      </div>
    );
  }

  const stepIcons = [IconBuilding, IconContact, IconPhone, IconExtensions, IconSms, IconCheck];
  const StepIcon = stepIcons[step] ?? IconCheck;

  const stepTitles = [
    "Tell us about your company",
    "Your contact details",
    "Phone number setup",
    "Your team extensions",
    "Communication add-ons",
    "Review & confirm",
  ];

  const stepSubtitles = [
    "We'll use this to set up your account and phone system.",
    "How do we reach you? Your billing contact can be different.",
    "Do you need a new number, or are you moving an existing one?",
    "Add each person who needs a phone extension.",
    "Would you like SMS messaging for your business?",
    "Everything look right? You can edit before submitting.",
  ];

  return (
    <>
      {/* Header */}
      <div className="ob-header">
        <div className="ob-logo">
          <div className="ob-logo-mark">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3" fill="rgba(255,255,255,0.9)"/>
              <circle cx="3" cy="5" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <circle cx="13" cy="5" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <circle cx="3" cy="11" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <circle cx="13" cy="11" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <line x1="8" y1="8" x2="3" y2="5"  stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
              <line x1="8" y1="8" x2="13" y2="5" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
              <line x1="8" y1="8" x2="3" y2="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
              <line x1="8" y1="8" x2="13" y2="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
            </svg>
          </div>
          <span className="ob-logo-text">Connect</span>
        </div>
        <div className="ob-save-indicator" style={{ opacity: saveState !== "idle" ? 1 : 0 }}>
          {saveState === "saving" ? (
            <>
              <div className="ob-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
              <span>Saving…</span>
            </>
          ) : (
            <>
              <div className="ob-save-dot" />
              <span>Saved</span>
            </>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="ob-progress">
        <div className="ob-progress-track">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`ob-progress-step${i < step ? " done" : i === step ? " active" : ""}`}
            />
          ))}
        </div>
        <div className="ob-progress-label">
          <span className="ob-progress-label-current">{STEPS[step]?.label}</span>
          <span>Step {step + 1} of {STEPS.length}</span>
        </div>
      </div>

      {/* Card */}
      <div className="ob-card" key={step}>
        <div className="ob-illustration">
          <StepIcon />
        </div>
        <div className="ob-step-eyebrow">Step {step + 1}</div>
        <h1 className="ob-step-title">{stepTitles[step]}</h1>
        <p className="ob-step-subtitle">{stepSubtitles[step]}</p>

        {/* ── Step 0: Company ── */}
        {step === 0 && (
          <div>
            <div className="ob-field">
              <label className="ob-label">Company name</label>
              <input className="ob-input" placeholder="Acme Corp" value={form.companyName}
                onChange={(e) => updateForm({ companyName: e.target.value })} />
            </div>
            <div className="ob-field-row">
              <div>
                <label className="ob-label">First name</label>
                <input className="ob-input" placeholder="Jane" value={form.firstName}
                  onChange={(e) => updateForm({ firstName: e.target.value })} />
              </div>
              <div>
                <label className="ob-label">Last name</label>
                <input className="ob-input" placeholder="Smith" value={form.lastName}
                  onChange={(e) => updateForm({ lastName: e.target.value })} />
              </div>
            </div>
          </div>
        )}

        {/* ── Step 1: Contact ── */}
        {step === 1 && (
          <div>
            <div className="ob-field">
              <label className="ob-label">Main phone number</label>
              <input className="ob-input" placeholder="(555) 000-0000" value={form.mainPhone}
                onChange={(e) => updateForm({ mainPhone: e.target.value })} />
            </div>
            <div className="ob-field">
              <label className="ob-label">Service address</label>
              <input className="ob-input" placeholder="123 Main St, City, State 00000" value={form.address}
                onChange={(e) => updateForm({ address: e.target.value })} />
              <div className="ob-field-hint">Used for E911 and number provisioning.</div>
            </div>
            <div className="ob-field">
              <label className="ob-label">Primary email</label>
              <input className="ob-input" type="email" placeholder="jane@acme.com" value={form.mainEmail}
                onChange={(e) => updateForm({ mainEmail: e.target.value })} />
            </div>
            <div className="ob-field">
              <label className="ob-label">
                Billing email
                <span className="ob-label-optional">(can be same as above)</span>
              </label>
              <input className="ob-input" type="email" placeholder="billing@acme.com" value={form.billingEmail}
                onChange={(e) => {
                  if (!form.billingEmail && form.mainEmail) updateForm({ billingEmail: e.target.value, mainEmail: form.mainEmail });
                  else updateForm({ billingEmail: e.target.value });
                }}
                onFocus={() => { if (!form.billingEmail && form.mainEmail) updateForm({ billingEmail: form.mainEmail }); }}
              />
            </div>
          </div>
        )}

        {/* ── Step 2: Phone setup ── */}
        {step === 2 && (
          <div>
            <div className="ob-choice-group">
              {(["new", "port", "unsure"] as const).map((choice) => {
                const labels: Record<string, [string, string]> = {
                  new:    ["Get a new number",          "We'll provision a fresh local or toll-free number for you."],
                  port:   ["Transfer my existing number","Keep your current number. We'll handle the porting process."],
                  unsure: ["Not sure yet",              "No problem — we can figure this out together after setup."],
                };
                return (
                  <div key={choice} className={`ob-choice${form.numberChoice === choice ? " selected" : ""}`}
                    onClick={() => updateForm({ numberChoice: choice })}>
                    <div className="ob-choice-radio">
                      <div className="ob-choice-radio-dot" />
                    </div>
                    <div className="ob-choice-body">
                      <div className="ob-choice-label">{labels[choice][0]}</div>
                      <div className="ob-choice-desc">{labels[choice][1]}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {form.numberChoice === "port" && (
              <div className="ob-porting-details">
                <div className="ob-step-eyebrow" style={{ marginBottom: 14 }}>Porting information</div>
                <div className="ob-choice" style={{ marginBottom: 14, cursor: "default" }}
                  onClick={() => updateForm({ provideNow: !form.provideNow })}>
                  <div className="ob-choice-radio">
                    <div className="ob-choice-radio-dot" style={{ transform: form.provideNow ? "scale(1)" : "scale(0)" }} />
                  </div>
                  <div className="ob-choice-body">
                    <div className="ob-choice-label">I have my account details ready</div>
                    <div className="ob-choice-desc">Carrier name, account number, porting PIN. You can also provide this later.</div>
                  </div>
                </div>

                {form.provideNow && (
                  <div>
                    <div className="ob-field-row">
                      <div>
                        <label className="ob-label">Current carrier</label>
                        <input className="ob-input" placeholder="AT&T, Spectrum…" value={form.porting.carrier}
                          onChange={(e) => updateForm({ porting: { ...form.porting, carrier: e.target.value } })} />
                      </div>
                      <div>
                        <label className="ob-label">Number(s) to port</label>
                        <input className="ob-input" placeholder="555-000-0000" value={form.porting.numbers}
                          onChange={(e) => updateForm({ porting: { ...form.porting, numbers: e.target.value } })} />
                      </div>
                    </div>
                    <div className="ob-field-row">
                      <div>
                        <label className="ob-label">Account number</label>
                        <input className="ob-input" placeholder="Account #" value={form.porting.accountNumber}
                          onChange={(e) => updateForm({ porting: { ...form.porting, accountNumber: e.target.value } })} />
                      </div>
                      <div>
                        <label className="ob-label">Porting PIN <span className="ob-label-optional">if required</span></label>
                        <input className="ob-input" placeholder="PIN" value={form.porting.portPin}
                          onChange={(e) => updateForm({ porting: { ...form.porting, portPin: e.target.value } })} />
                      </div>
                    </div>
                    <div className="ob-field">
                      <label className="ob-label">Name on account</label>
                      <input className="ob-input" placeholder="As it appears on your phone bill" value={form.porting.nameOnAccount}
                        onChange={(e) => updateForm({ porting: { ...form.porting, nameOnAccount: e.target.value } })} />
                    </div>
                    <div className="ob-field" style={{ marginBottom: 0 }}>
                      <label className="ob-label">Service address on account</label>
                      <input className="ob-input" placeholder="Billing address on your current carrier account" value={form.porting.serviceAddress}
                        onChange={(e) => updateForm({ porting: { ...form.porting, serviceAddress: e.target.value } })} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Extensions ── */}
        {step === 3 && (
          <div>
            <table className="ob-ext-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ext #</th>
                  <th>Email <span className="ob-label-optional">optional</span></th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {form.extensions.map((ext, i) => (
                  <tr key={i} className="ob-ext-row">
                    <td>
                      <input className="ob-input" placeholder="Jane Smith" value={ext.displayName}
                        onChange={(e) => updateExt(i, { displayName: e.target.value })} />
                    </td>
                    <td>
                      <input className="ob-input" placeholder="101" value={ext.extNumber}
                        onChange={(e) => updateExt(i, { extNumber: e.target.value.replace(/\D/g, "") })} style={{ textAlign: "center" }} />
                    </td>
                    <td>
                      <input className="ob-input" type="email" placeholder="jane@acme.com" value={ext.email}
                        onChange={(e) => updateExt(i, { email: e.target.value })} />
                    </td>
                    <td>
                      {form.extensions.length > 1 && (
                        <button className="ob-ext-remove" onClick={() => removeExt(i)} title="Remove">×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="ob-ext-add" onClick={addExt}>+ Add extension</button>
            <div className="ob-field-hint" style={{ marginTop: 10 }}>
              Each extension becomes a phone line. Email is optional but enables voicemail-to-email.
            </div>
          </div>
        )}

        {/* ── Step 4: Add-ons ── */}
        {step === 4 && (
          <div>
            <div className={`ob-toggle-row${form.smsEnabled ? " on" : ""}`}
              onClick={() => updateForm({ smsEnabled: !form.smsEnabled })}
              style={{ cursor: "pointer" }}>
              <div className="ob-toggle-info">
                <div className="ob-toggle-title">Business SMS messaging</div>
                <div className="ob-toggle-desc">
                  Send and receive texts from your business number. <strong>$10/mo add-on.</strong>
                </div>
              </div>
              <label className="ob-toggle-switch" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={form.smsEnabled}
                  onChange={(e) => updateForm({ smsEnabled: e.target.checked })} />
                <span className="ob-toggle-track" />
              </label>
            </div>
            <div className="ob-field-hint" style={{ marginTop: 12 }}>
              You can change this any time from your account settings.
            </div>
          </div>
        )}

        {/* ── Step 5: Review ── */}
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
              <div className="ob-review-row"><span className="ob-review-key">Billing email</span><span className="ob-review-val">{form.billingEmail}</span></div>
            </div>

            <div className="ob-review-section">
              <div className="ob-review-section-title">Phone setup</div>
              <div className="ob-review-row">
                <span className="ob-review-key">Number choice</span>
                <span className="ob-review-val">
                  {form.numberChoice === "new" ? "Get a new number" : form.numberChoice === "port" ? "Transfer existing" : "Not sure yet"}
                </span>
              </div>
              {form.numberChoice === "port" && form.provideNow && form.porting.carrier && (
                <div className="ob-review-row"><span className="ob-review-key">Carrier</span><span className="ob-review-val">{form.porting.carrier}</span></div>
              )}
            </div>

            <div className="ob-review-section">
              <div className="ob-review-section-title">Extensions ({form.extensions.filter((e) => e.extNumber).length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {form.extensions.filter((e) => e.extNumber).map((e, i) => (
                  <div key={i} className="ob-review-ext-chip">
                    <span className="ob-review-ext-num">{e.extNumber}</span>
                    {e.displayName}
                  </div>
                ))}
              </div>
            </div>

            <div className="ob-review-section">
              <div className="ob-review-section-title">Add-ons</div>
              <div className="ob-review-row">
                <span className="ob-review-key">SMS messaging</span>
                <span className="ob-review-val" style={{ color: form.smsEnabled ? "#059669" : undefined }}>
                  {form.smsEnabled ? "Enabled ($10/mo)" : "Not added"}
                </span>
              </div>
            </div>

            {submitError && <div className="ob-error">{submitError}</div>}
          </div>
        )}

        {/* ── Validation error ── */}
        {stepError && <div className="ob-error">{stepError}</div>}

        {/* ── Navigation ── */}
        <div className="ob-actions">
          {step > 0 ? (
            <button className="ob-btn-back" onClick={goBack}>
              <IconArrowLeft /> Back
            </button>
          ) : <div />}

          {step < STEPS.length - 1 ? (
            <button className="ob-btn-next" onClick={goNext}>
              Continue <IconArrowRight />
            </button>
          ) : (
            <button
              className="ob-btn-next ob-btn-submit"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Submitting…" : "Submit setup request"}
              {!submitting && <IconArrowRight />}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
