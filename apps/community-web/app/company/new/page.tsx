"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Field, useToast } from "@/components/ui";

function NewCompanyForm() {
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const claimLoopcom = params.get("claim") === "1";
  const [displayName, setDisplayName] = useState("");
  const [industry, setIndustry] = useState("");
  const [size, setSize] = useState("");
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (displayName.trim().length < 2) {
      setError("Enter the company's name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const org = await api<{ id: string; slug: string; displayName: string }>("/organizations", {
        method: "POST",
        body: { displayName: displayName.trim(), industry: industry || undefined, size: size || undefined, website: website || undefined, description: description || undefined },
      });
      if (claimLoopcom) {
        try {
          await api(`/organizations/${org.id}/claim-loopcom`, { method: "POST" });
          toast(`${org.displayName} is live and linked to your Loopcom account.`);
        } catch (err) {
          toast(`Company created, but the Loopcom claim failed: ${(err as ApiError).message}`, { kind: "err" });
        }
      } else {
        toast(`${org.displayName} is live.`);
      }
      router.push(`/companies/${org.slug}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't create the company page.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
      <form className="card" onSubmit={submit}>
        <div className="ct">{claimLoopcom ? "Create & claim your company page" : "Create a company page"}</div>
        {claimLoopcom ? <p className="sm dim" style={{ marginBottom: 10 }}>We'll link this page to your Loopcom account as soon as it's created.</p> : null}
        <Field label="Company name" htmlFor="co-name">
          <input id="co-name" className="in" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} required data-testid="company-new-name" />
        </Field>
        <Field label="Industry" htmlFor="co-industry" help="e.g. Apparel & uniforms">
          <input id="co-industry" className="in" value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={80} data-testid="company-new-industry" />
        </Field>
        <Field label="Company size" htmlFor="co-size" help="e.g. 11–50 employees">
          <input id="co-size" className="in" value={size} onChange={(e) => setSize(e.target.value)} maxLength={40} data-testid="company-new-size" />
        </Field>
        <Field label="Website" htmlFor="co-web">
          <input id="co-web" className="in" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={300} placeholder="https://" data-testid="company-new-website" />
        </Field>
        <Field label="About" htmlFor="co-desc">
          <textarea id="co-desc" className="in" style={{ minHeight: 90 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} data-testid="company-new-description" />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row" style={{ marginTop: 10 }}>
          <Button kind="p" type="submit" loading={busy} data-testid="company-new-submit">
            Create company page
          </Button>
          <Button kind="g" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewCompanyPage() {
  return (
    <RequireAuth>
      <AppShell title="Create a company page">
        <NewCompanyForm />
      </AppShell>
    </RequireAuth>
  );
}
