"use client";

import { FormEvent, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function TenDlcPage() {
  const [form, setForm] = useState({
    legalName: "",
    dba: "",
    ein: "",
    businessType: "LLC",
    websiteUrl: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
    supportEmail: "Support@connectcomunications.com",
    supportPhone: "",
    useCaseCategory: "marketing",
    sample1: "",
    sample2: "",
    sample3: "",
    optInMethod: "website_form",
    optInWorkflowDescription: "",
    optInProofUrl: "",
    messagesPerDay: "100",
    messagesPerMonth: "3000",
    includesEmbeddedLinks: false,
    includesEmbeddedPhoneNumbers: true,
    includesAffiliateMarketing: false,
    ageGatedContent: false,
    termsAccepted: false,
    signatureName: "",
    signatureDate: new Date().toISOString().slice(0, 10)
  });
  const [result, setResult] = useState("");

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!form.legalName) errors.push("Business Legal Name is required.");
    if (!/^https?:\/\//i.test(form.websiteUrl)) errors.push("Website URL must start with http:// or https://");
    if (!form.sample1 || !form.sample2 || !form.sample3) errors.push("Three message samples are required.");
    if (!form.termsAccepted) errors.push("Terms must be accepted.");
    return errors;
  }, [form]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (validationErrors.length > 0) {
      setResult(`Validation failed:\n- ${validationErrors.join("\n- ")}`);
      return;
    }

    const token = localStorage.getItem("token") || "";
    const payload = {
      legalName: form.legalName,
      dba: form.dba || undefined,
      ein: form.ein,
      businessType: form.businessType,
      websiteUrl: form.websiteUrl,
      businessAddress: {
        street: form.street,
        city: form.city,
        state: form.state,
        zip: form.zip,
        country: form.country
      },
      supportEmail: form.supportEmail,
      supportPhone: form.supportPhone,
      useCaseCategory: form.useCaseCategory,
      messageSamples: [form.sample1, form.sample2, form.sample3],
      optInMethod: form.optInMethod,
      optInWorkflowDescription: form.optInWorkflowDescription,
      optInProofUrl: form.optInProofUrl || undefined,
      volumeEstimate: {
        messagesPerDay: Number(form.messagesPerDay),
        messagesPerMonth: Number(form.messagesPerMonth)
      },
      includesEmbeddedLinks: form.includesEmbeddedLinks,
      includesEmbeddedPhoneNumbers: form.includesEmbeddedPhoneNumbers,
      includesAffiliateMarketing: form.includesAffiliateMarketing,
      ageGatedContent: form.ageGatedContent,
      termsAccepted: true,
      signatureName: form.signatureName,
      signatureDate: form.signatureDate
    };

    const resp = await fetch(`${apiBase}/ten-dlc/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json();
    setResult(JSON.stringify(json, null, 2));
  }

  return (
    <div className="card">
      <h1>Business Texting Registration (10DLC)</h1>
      <p>
        10DLC is the U.S. carrier registration framework for application-to-person messaging over standard long code numbers.
        Registration helps carriers verify sender identity, enforce trust rules, and reduce filtering risk.
      </p>
      <p>
        Approval depends on registry and carrier review. Typical processing windows vary by queue volume and submission quality.
        Incomplete submissions or unclear consent flows are the most common causes of delays.
      </p>

      <h2>Required Information Checklist</h2>
      <ul>
        <li>Legal business identity and tax information</li>
        <li>Public website and support contact details</li>
        <li>Clear use case category and three realistic message samples</li>
        <li>Documented opt-in workflow and evidence source</li>
        <li>Expected sending volume and campaign attributes</li>
      </ul>

      <h2>Messaging Compliance</h2>
      <ul>
        <li>Obtain explicit consent before sending promotional or recurring messages.</li>
        <li>Honor STOP and HELP keywords immediately with clear support guidance.</li>
        <li>Disclose frequency expectations at opt-in and in program terms.</li>
        <li>Maintain accessible privacy policy and terms language.</li>
        <li>Prohibited content includes sexual content, hate, alcohol/tobacco to minors, firearms trafficking, and related high-risk abuse patterns.</li>
      </ul>

      <form onSubmit={onSubmit}>
        <h3>Business Profile</h3>
        <input placeholder="Business Legal Name" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        <input placeholder="DBA (optional)" value={form.dba} onChange={(e) => setForm({ ...form, dba: e.target.value })} />
        <input placeholder="EIN / Tax ID" value={form.ein} onChange={(e) => setForm({ ...form, ein: e.target.value })} />
        <select value={form.businessType} onChange={(e) => setForm({ ...form, businessType: e.target.value })}>
          <option value="LLC">LLC</option><option value="CORP">Corp</option><option value="SOLE_PROP">Sole Prop</option><option value="NONPROFIT">Nonprofit</option>
        </select>
        <input placeholder="Website URL" value={form.websiteUrl} onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })} />

        <h3>Address</h3>
        <input placeholder="Street" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
        <input placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <input placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
        <input placeholder="ZIP" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
        <input placeholder="Country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />

        <h3>Support + Use Case</h3>
        <input placeholder="Support Email" value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} />
        <input placeholder="Support Phone" value={form.supportPhone} onChange={(e) => setForm({ ...form, supportPhone: e.target.value })} />
        <select value={form.useCaseCategory} onChange={(e) => setForm({ ...form, useCaseCategory: e.target.value })}>
          <option value="marketing">Marketing</option>
          <option value="notifications">Notifications</option>
          <option value="2fa">2FA</option>
          <option value="customer_care">Customer Care</option>
          <option value="mixed">Mixed</option>
        </select>

        <h3>Message Samples + Opt-In</h3>
        <textarea placeholder="Message sample #1" value={form.sample1} onChange={(e) => setForm({ ...form, sample1: e.target.value })} />
        <textarea placeholder="Message sample #2" value={form.sample2} onChange={(e) => setForm({ ...form, sample2: e.target.value })} />
        <textarea placeholder="Message sample #3" value={form.sample3} onChange={(e) => setForm({ ...form, sample3: e.target.value })} />
        <select value={form.optInMethod} onChange={(e) => setForm({ ...form, optInMethod: e.target.value })}>
          <option value="website_form">Website form</option>
          <option value="paper_form">Paper form</option>
          <option value="verbal">Verbal</option>
          <option value="keyword">Keyword</option>
          <option value="other">Other</option>
        </select>
        <textarea placeholder="Describe your opt-in workflow" value={form.optInWorkflowDescription} onChange={(e) => setForm({ ...form, optInWorkflowDescription: e.target.value })} />
        <input placeholder="Proof URL (optional)" value={form.optInProofUrl} onChange={(e) => setForm({ ...form, optInProofUrl: e.target.value })} />

        <h3>Volume + Campaign Attributes</h3>
        <input placeholder="Messages/day" value={form.messagesPerDay} onChange={(e) => setForm({ ...form, messagesPerDay: e.target.value })} />
        <input placeholder="Messages/month" value={form.messagesPerMonth} onChange={(e) => setForm({ ...form, messagesPerMonth: e.target.value })} />
        <label><input type="checkbox" checked={form.includesEmbeddedLinks} onChange={(e) => setForm({ ...form, includesEmbeddedLinks: e.target.checked })} /> Includes links</label>
        <label><input type="checkbox" checked={form.includesEmbeddedPhoneNumbers} onChange={(e) => setForm({ ...form, includesEmbeddedPhoneNumbers: e.target.checked })} /> Includes phone numbers</label>
        <label><input type="checkbox" checked={form.includesAffiliateMarketing} onChange={(e) => setForm({ ...form, includesAffiliateMarketing: e.target.checked })} /> Includes affiliate marketing</label>
        <label><input type="checkbox" checked={form.ageGatedContent} onChange={(e) => setForm({ ...form, ageGatedContent: e.target.checked })} /> Age-gated content</label>

        <h3>Attestation</h3>
        <label><input type="checkbox" checked={form.termsAccepted} onChange={(e) => setForm({ ...form, termsAccepted: e.target.checked })} /> I confirm this submission is accurate and consent records are available.</label>
        <input placeholder="Signature Name" value={form.signatureName} onChange={(e) => setForm({ ...form, signatureName: e.target.value })} />
        <input type="date" value={form.signatureDate} onChange={(e) => setForm({ ...form, signatureDate: e.target.value })} />

        <button type="submit">Submit 10DLC Registration</button>
      </form>

      <pre>{result}</pre>
    </div>
  );
}
