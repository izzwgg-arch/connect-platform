"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, API_URL, getAccessToken, signOutLocal } from "@/lib/api";
import { Button, Dialog, Field, useToast } from "@/components/ui";

export default function DataPage() {
  const toast = useToast();
  const router = useRouter();
  const [delOpen, setDelOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function exportData() {
    const res = await fetch(`${API_URL}/auth/export`, { headers: { authorization: `Bearer ${getAccessToken()}` } });
    if (!res.ok) return toast("Export failed. Try again in a minute.", { kind: "err" });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "loopcom-community-export.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("Export downloaded.");
  }
  async function deactivate() {
    if (!window.confirm("Deactivate your profile? It is hidden until you sign in again.")) return;
    await api("/auth/deactivate", { method: "POST" });
    signOutLocal();
    router.replace("/");
  }
  async function del() {
    setBusy(true);
    try {
      await api("/auth/delete", { body: { confirm: "DELETE", password: pw || undefined } });
      signOutLocal();
      router.replace("/?deleted=1");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="card">
        <div className="ct">Your data</div>
        <p className="sm dim">Everything you have added — profile, posts, messages you sent, notes, RFQs, quotes, applications — as one JSON file.</p>
        <div className="row" style={{ marginTop: 10 }}>
          <Button icon="dl" onClick={exportData} data-testid="export-data">Export my data (JSON)</Button>
        </div>
      </div>
      <div className="card">
        <div className="ct">Deactivate or delete</div>
        <div className="row">
          <Button onClick={deactivate} data-testid="deactivate">Deactivate</Button>
          <Button kind="d" icon="trash" onClick={() => setDelOpen(true)} data-testid="delete-account">Delete account</Button>
        </div>
        <p className="xs dim" style={{ marginTop: 8 }}>Deletion takes effect after 14 days; sign in before then to cancel. Posts and quotes you sent to others are anonymised, not removed from their records.</p>
      </div>
      <Dialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title="Delete your Loopcom ID"
        footer={
          <>
            <Button kind="g" onClick={() => setDelOpen(false)}>Keep my account</Button>
            <Button kind="d" onClick={del} loading={busy} data-testid="delete-confirm">Delete in 14 days</Button>
          </>
        }
      >
        <p className="sm">Enter your password to confirm (skip if you sign in with Loopcom, Google or Apple only).</p>
        <Field label="Password" htmlFor="del-pw">
          <input id="del-pw" className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
