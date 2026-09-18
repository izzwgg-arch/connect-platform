"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Empty, useToast } from "@/components/ui";
import type { PersonCard } from "@/components/graph/types";

/** Parses a CSV/VCF export or a plain pasted list into emails/phones — nothing leaves the browser until Find matches. */
function extractContacts(text: string): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const phoneRe = /(?:\+?\d[\d\s().-]{7,}\d)/g;
  for (const m of text.match(emailRe) ?? []) emails.add(m.trim().toLowerCase());
  for (const m of text.match(phoneRe) ?? []) {
    const digits = m.replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length >= 10) phones.add(digits);
  }
  return { emails: [...emails], phones: [...phones] };
}

export default function ImportContactsPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileText, setFileText] = useState("");
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<PersonCard[] | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setFileText(await file.text());
  }

  async function findMatches() {
    const combined = `${pasted}\n${fileText}`;
    const { emails, phones } = extractContacts(combined);
    if (!emails.length && !phones.length) {
      toast("Paste some emails or upload a CSV/VCF export first.", { kind: "err" });
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ matches: PersonCard[] }>("/network/match", { method: "POST", body: { emails, phones } });
      setMatches(r.matches);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't check for matches.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function connect(personId: string) {
    setConnecting(personId);
    try {
      const r = await api<{ status: string }>("/connections/request", { method: "POST", body: { personId } });
      setSent((s) => new Set(s).add(personId));
      toast(r.status === "ACTIVE" ? "You're connected." : "Request sent.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't send that request.", { kind: "err" });
    } finally {
      setConnecting(null);
    }
  }

  return (
    <AppShell title="Import contacts" cols="narrow">
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 18 }}>Import contacts</h2>
          <Link href="/network" className="sm dim">
            Back to My network
          </Link>
        </div>
        <p className="sm dim" style={{ margin: "6px 0 14px" }}>
          Upload a contacts export (CSV or VCF) or paste emails — we only check which of them are already on Loopcom Community, using their verified email or (if they allow it) phone number. Nothing else is stored or shared.
        </p>
        <div className="field">
          <label className="lbl" htmlFor="import-file">
            Contacts file (CSV or VCF)
          </label>
          <input id="import-file" type="file" accept=".csv,.vcf,text/csv,text/vcard" onChange={onFile} data-testid="import-file-input" />
          {fileName ? <span className="help">{fileName} loaded</span> : null}
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label className="lbl" htmlFor="import-paste">
            Or paste emails
          </label>
          <textarea id="import-paste" className="in" rows={4} placeholder="jane@example.com, john@example.com…" value={pasted} onChange={(e) => setPasted(e.target.value)} data-testid="import-paste-input" />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Button kind="p" icon="search" loading={busy} onClick={() => void findMatches()} data-testid="import-find">
            Find matches
          </Button>
        </div>
      </div>

      {matches !== null ? (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="ct">Matches on Loopcom Community</div>
          {matches.length === 0 ? (
            <Empty title="No matches found" text="Nobody in that list is on Loopcom Community with a verified email or phone yet." />
          ) : (
            <div className="list" data-testid="import-matches-list">
              {matches.map((p) => (
                <div className="li" key={p.id}>
                  <Avatar name={p.name} assetId={p.avatarAssetId} size={40} />
                  <div className="t">
                    <b>{p.name}</b>
                    <small>{[p.headline, p.primaryOrg?.displayName].filter(Boolean).join(" · ")}</small>
                  </div>
                  {sent.has(p.id) ? (
                    <span className="chip ok">Sent</span>
                  ) : (
                    <Button small kind="p" icon="plus" loading={connecting === p.id} onClick={() => connect(p.id)} data-testid={`import-connect-${p.id}`}>
                      Connect
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </AppShell>
  );
}
