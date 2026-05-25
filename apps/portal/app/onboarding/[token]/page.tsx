"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPut, apiPost } from "../../../services/apiClient";

export default function PublicOnboardingPage({ params }: { params: { token: string } }) {
  const token = params.token;
  const [exists, setExists] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state (minimal)
  const [companyName, setCompanyName] = useState("");
  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [mainEmail, setMainEmail] = useState("");
  const [billingEmail, setBillingEmail] = useState("");

  useEffect(() => {
    async function run() {
      try {
        const r = await apiGet<{ ok: boolean; exists: boolean }>(`/onboarding/${encodeURIComponent(token)}/validate`);
        setExists(r.exists);
      } catch (e: any) {
        setError(e?.message || String(e));
      }
    }
    run();
  }, [token]);

  async function autosave() {
    setSaving(true);
    setError(null);
    try {
      await apiPut(`/onboarding/${encodeURIComponent(token)}/save`, {
        currentStep: "company",
        answers: { companyName },
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/onboarding/${encodeURIComponent(token)}/submit`, {
        companyName,
        contactFirstName,
        contactLastName,
        mainEmail,
        billingEmail,
        smsEnabled: true,
        extensions: [
          { displayName: "Front Desk", extNumber: "101", email: "front@example.com" },
          { displayName: "Office", extNumber: "102", email: "office@example.com" },
        ],
      });
      window.location.href = `/onboarding/${encodeURIComponent(token)}/success`;
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <div className="state-box error">{error}</div>;
  if (exists === null) return <div className="state-box">Loading…</div>;

  return (
    <div className="stack">
      <h1>Customer Onboarding</h1>
      {exists === false ? <div className="state-box">Welcome! Continue to enter your details.</div> : null}

      <div className="card">
        <div className="row"><label style={{ width: 160 }}>Company</label><input value={companyName} onChange={(e) => setCompanyName(e.target.value)} onBlur={autosave} /></div>
        <div className="row"><label style={{ width: 160 }}>First name</label><input value={contactFirstName} onChange={(e) => setContactFirstName(e.target.value)} /></div>
        <div className="row"><label style={{ width: 160 }}>Last name</label><input value={contactLastName} onChange={(e) => setContactLastName(e.target.value)} /></div>
        <div className="row"><label style={{ width: 160 }}>Main email</label><input value={mainEmail} onChange={(e) => setMainEmail(e.target.value)} /></div>
        <div className="row"><label style={{ width: 160 }}>Billing email</label><input value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} /></div>
      </div>

      <div className="row">
        <button disabled={saving} onClick={autosave}>{saving ? "Saving…" : "Save"}</button>
        <button disabled={submitting} onClick={submit} style={{ marginLeft: 8 }}>{submitting ? "Submitting…" : "Submit"}</button>
      </div>
    </div>
  );
}
