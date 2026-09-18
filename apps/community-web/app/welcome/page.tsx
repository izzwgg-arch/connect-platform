"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { Avatar, Button, Chip, Field, Icon, useToast } from "@/components/ui";

const OBJECTIVES = ["Grow my business", "Find customers", "Find vendors", "Professional networking", "Find employment", "Hire employees", "Recruit", "Sell services", "Find partners", "Attend events", "Learn", "Find referrals"];
const INDUSTRIES = ["Apparel & uniforms", "Printing & signage", "Construction & trades", "Real estate", "Healthcare", "ABA & special education", "Retail", "Wholesale & distribution", "Technology", "Telecom", "Accounting & bookkeeping", "Transportation & logistics", "Food & catering", "Nonprofit", "Education", "Legal", "Insurance", "Marketing", "Manufacturing", "Other"];
const LANGUAGES = ["English", "Yiddish", "Hebrew", "Spanish", "Russian", "French", "Hungarian", "Portuguese"];

const STEPS = ["About you", "What you're here for", "Skills & services", "Where you work", "Follow a few companies"];

type OrgLite = { id: string; slug: string; displayName: string; logoAssetId: string | null; industry: string | null; followerCount?: number; reason?: string };

function Onboarding() {
  const router = useRouter();
  const toast = useToast();
  const { me, reload } = useAuth();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [headline, setHeadline] = useState(me?.profile?.headline ?? "");
  const [industry, setIndustry] = useState(me?.profile?.industry ?? "");
  const [location, setLocation] = useState(me?.profile?.location ?? "");
  const [employer, setEmployer] = useState("");
  const [title, setTitle] = useState("");
  const [objectives, setObjectives] = useState<string[]>(me?.profile?.objectives ?? []);
  const [skills, setSkills] = useState<string[]>(me?.profile?.skills ?? []);
  const [skillInput, setSkillInput] = useState("");
  const [services, setServices] = useState("");
  const [serviceArea, setServiceArea] = useState((me?.profile?.serviceArea ?? []).join(", "));
  const [languages, setLanguages] = useState<string[]>(me?.profile?.languages ?? ["English"]);
  const [suggested, setSuggested] = useState<OrgLite[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [orgMatches, setOrgMatches] = useState<OrgLite[]>([]);

  useEffect(() => {
    if (step === 4) api<{ organizations: OrgLite[] }>("/recommendations/organizations?limit=8").then((r) => setSuggested(r.organizations)).catch(() => setSuggested([]));
  }, [step]);

  useEffect(() => {
    if (employer.trim().length < 2) return setOrgMatches([]);
    const t = setTimeout(() => api<{ organizations: OrgLite[] }>(`/organizations?q=${encodeURIComponent(employer.trim())}&limit=5`).then((r) => setOrgMatches(r.organizations)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [employer]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function saveStep() {
    setBusy(true);
    try {
      if (step === 0) {
        await api("/me/profile", { method: "PATCH", body: { headline: headline || undefined, industry: industry || undefined, location: location || undefined } });
        if (employer.trim() && title.trim()) {
          await api("/me/profile/experiences", { body: { companyName: employer.trim(), title: title.trim(), startDate: new Date().toISOString().slice(0, 10), isCurrent: true, organizationId: orgMatches.find((o) => o.displayName.toLowerCase() === employer.trim().toLowerCase())?.id } });
        }
      }
      if (step === 1) await api("/me/profile", { method: "PATCH", body: { objectives } });
      if (step === 2) {
        await api("/me/profile", { method: "PATCH", body: { skills } });
        for (const s of services.split(",").map((x) => x.trim()).filter(Boolean)) await api("/me/profile/services", { body: { name: s } });
      }
      if (step === 3) await api("/me/profile", { method: "PATCH", body: { serviceArea: serviceArea.split(",").map((x) => x.trim()).filter(Boolean), languages } });
      if (step === 4) return finish();
      setStep(step + 1);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await api("/me/onboarding/done", { method: "POST" });
      await reload();
      router.replace("/");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function follow(o: OrgLite) {
    try {
      if (followed.has(o.id)) {
        await api(`/organizations/${o.id}/follow`, { method: "DELETE" });
        setFollowed((s) => { const n = new Set(s); n.delete(o.id); return n; });
      } else {
        await api(`/organizations/${o.id}/follow`, { method: "POST" });
        setFollowed((s) => new Set(s).add(o.id));
      }
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="auth" style={{ alignItems: "start", paddingTop: 36 }}>
      <div className="authcard wide">
        <div className="row" style={{ gap: 18 }}>
          {STEPS.map((t, i) => (
            <span key={t} className={`step ${i < step ? "done" : i === step ? "now" : ""}`}>
              <i>{i < step ? <Icon name="check" /> : i + 1}</i>
              {t}
            </span>
          ))}
        </div>
        <div className="prog"><i style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>

        {step === 0 ? (
          <>
            <div><h1 style={{ fontSize: 20 }}>Tell people who you are</h1><p className="dim">A headline and where you work. Everything here is editable later on your profile.</p></div>
            <Field label="Headline" htmlFor="ob-headline" help="e.g. Owner, Weiss Embroidery & Uniforms · Custom apparel for schools and camps">
              <input id="ob-headline" className="in" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={120} data-testid="ob-headline" />
            </Field>
            <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <div style={{ flex: 1, position: "relative" }}>
                <Field label="Employer / business" htmlFor="ob-employer">
                  <input id="ob-employer" className="in" value={employer} onChange={(e) => setEmployer(e.target.value)} autoComplete="organization" data-testid="ob-employer" />
                </Field>
                {orgMatches.length ? (
                  <div className="menu" style={{ position: "absolute", left: 0, right: 0, top: "100%" }}>
                    {orgMatches.map((o) => (
                      <button type="button" key={o.id} onClick={() => { setEmployer(o.displayName); setOrgMatches([]); }}>
                        <Avatar name={o.displayName} assetId={o.logoAssetId} size={22} square /> {o.displayName}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Title" htmlFor="ob-title">
                  <input id="ob-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="organization-title" data-testid="ob-title" />
                </Field>
              </div>
            </div>
            <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <Field label="Industry" htmlFor="ob-industry">
                  <select id="ob-industry" className="in" value={industry} onChange={(e) => setIndustry(e.target.value)} data-testid="ob-industry">
                    <option value="">Choose…</option>
                    {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Location" htmlFor="ob-location" help="City or area, e.g. Monroe, NY">
                  <input id="ob-location" className="in" value={location} onChange={(e) => setLocation(e.target.value)} data-testid="ob-location" />
                </Field>
              </div>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div><h1 style={{ fontSize: 20 }}>What brings you to Loopcom Community?</h1><p className="dim">Pick as many as fit. This shapes your home feed and who we suggest — you can change it any time in Settings.</p></div>
            <div className="pill-row" style={{ gap: 8 }}>
              {OBJECTIVES.map((o) => (
                <Chip key={o} kind={objectives.includes(o) ? "sel" : ""} icon={objectives.includes(o) ? "check" : undefined} onClick={() => toggle(objectives, setObjectives, o)} className="big">
                  {o}
                </Chip>
              ))}
            </div>
            {me?.person.loopcomLinked ? (
              <div className="card tight" style={{ background: "var(--bg-soft)" }}>
                <div className="row sm"><span className="dim">Your Loopcom account is linked</span><Chip kind="ac" icon="link">Loopcom customer</Chip><span className="dim">— claim your company page from Company admin.</span></div>
              </div>
            ) : null}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div><h1 style={{ fontSize: 20 }}>Skills and services</h1><p className="dim">What you're good at, and what you sell. Both are searchable.</p></div>
            <Field label="Skills" htmlFor="ob-skill" help="Type one and press Enter.">
              <input id="ob-skill" className="in" value={skillInput} onChange={(e) => setSkillInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && skillInput.trim()) { e.preventDefault(); if (!skills.includes(skillInput.trim())) setSkills([...skills, skillInput.trim()]); setSkillInput(""); } }} data-testid="ob-skill" />
            </Field>
            <div className="pill-row">{skills.map((s) => <Chip key={s} kind="ac" onClick={() => setSkills(skills.filter((x) => x !== s))} title="Remove">{s} ×</Chip>)}</div>
            <Field label="Services you offer (comma separated)" htmlFor="ob-services" help="e.g. Embroidery, Screen printing, Uniform programs">
              <input id="ob-services" className="in" value={services} onChange={(e) => setServices(e.target.value)} data-testid="ob-services" />
            </Field>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div><h1 style={{ fontSize: 20 }}>Where you work</h1><p className="dim">Service area and languages help the right people find you.</p></div>
            <Field label="Service area (comma separated)" htmlFor="ob-area" help="e.g. Orange County, Rockland County, Brooklyn">
              <input id="ob-area" className="in" value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} data-testid="ob-area" />
            </Field>
            <span className="lbl">Languages</span>
            <div className="pill-row">{LANGUAGES.map((l) => <Chip key={l} kind={languages.includes(l) ? "sel" : ""} onClick={() => toggle(languages, setLanguages, l)}>{l}</Chip>)}</div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <div><h1 style={{ fontSize: 20 }}>Follow a few companies</h1><p className="dim">Suggested from your industry and area. Following puts their updates in your feed.</p></div>
            {suggested.length === 0 ? <p className="dim sm">No suggestions yet — you'll find companies in Search once you're in.</p> : null}
            <div className="grid2">
              {suggested.map((o) => (
                <div key={o.id} className="card tight">
                  <div className="li">
                    <Avatar name={o.displayName} assetId={o.logoAssetId} size={40} square />
                    <div className="t"><b>{o.displayName}</b><small>{o.industry ?? ""}{o.reason ? ` · ${o.reason}` : ""}</small></div>
                    <Button small kind={followed.has(o.id) ? "" : "p"} onClick={() => follow(o)} data-testid={`ob-follow-${o.slug}`}>{followed.has(o.id) ? "Following ✓" : "Follow"}</Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="row" style={{ justifyContent: "space-between" }}>
          <Button kind="g" icon="back" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0 || busy}>Back</Button>
          <span className="row">
            <Button kind="g" onClick={finish} disabled={busy} data-testid="ob-skip">Skip for now</Button>
            <Button kind="p" onClick={saveStep} loading={busy} data-testid="ob-continue">{step === STEPS.length - 1 ? "Finish" : "Continue"} <Icon name="arrow" /></Button>
          </span>
        </div>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return <RequireAuth><Onboarding /></RequireAuth>;
}
