"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Dialog, Empty, Field, Skeleton, fmtDate, useToast } from "@/components/ui";

type Verification = { id: string; personId: string | null; organizationId: string | null; kind: string; status: string; evidence: Record<string, unknown> | null; note: string | null; createdAt: string };

export default function AdminVerificationsPage() {
  const toast = useToast();
  const [items, setItems] = useState<Verification[]>([]);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState<{ v: Verification; status: "VERIFIED" | "REJECTED" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api<{ verifications: Verification[] }>("/admin/verifications?status=PENDING")
      .then((r) => setItems(r.verifications))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function confirm() {
    if (!deciding) return;
    setBusy(true);
    try {
      await api(`/admin/verifications/${deciding.v.id}/decide`, { method: "POST", body: { status: deciding.status, note: note.trim() || undefined } });
      toast(`${deciding.status === "VERIFIED" ? "Approved" : "Rejected"}.`);
      setDeciding(null);
      setNote("");
      load();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col">
      <h1>Verification queue</h1>
      <p className="sub">Pending identity, business, license and domain verification requests.</p>
      <div className="card">
        {loading && !items.length ? (
          <Skeleton h={250} />
        ) : !items.length ? (
          <Empty title="Nothing pending" text="The queue is empty." />
        ) : (
          <div className="list sm">
            {items.map((v) => (
              <div className="li" key={v.id} data-testid={`admin-verification-row-${v.id}`}>
                <div className="t">
                  <b>{v.kind}</b>
                  <small>{v.personId ? `Person ${v.personId}` : `Company ${v.organizationId}`}</small>
                  {v.evidence ? <small className="dim">{JSON.stringify(v.evidence)}</small> : null}
                  <small className="dim">{fmtDate(v.createdAt)}</small>
                </div>
                <div className="row">
                  <Button small kind="g" onClick={() => setDeciding({ v, status: "REJECTED" })}>
                    Reject
                  </Button>
                  <Button small kind="p" onClick={() => setDeciding({ v, status: "VERIFIED" })}>
                    Approve
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={!!deciding}
        onClose={() => setDeciding(null)}
        title={deciding ? (deciding.status === "VERIFIED" ? "Approve verification" : "Reject verification") : ""}
        footer={
          <>
            <Button kind="g" onClick={() => setDeciding(null)}>
              Cancel
            </Button>
            <Button kind="p" onClick={confirm} loading={busy} data-testid="admin-verification-confirm">
              Confirm
            </Button>
          </>
        }
      >
        <Field label="Note (optional)" htmlFor="admin-verification-note">
          <textarea id="admin-verification-note" className="in" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
