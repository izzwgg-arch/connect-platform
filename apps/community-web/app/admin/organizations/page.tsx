"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Field, Skeleton, useToast } from "@/components/ui";

type OrgRow = { id: string; slug: string; displayName: string; logoAssetId: string | null; industry: string | null; status: string; followerCount: number };

const STATUS_KIND: Record<string, "" | "ok" | "warn" | "bad"> = { ACTIVE: "ok", SUSPENDED: "warn", BANNED: "bad" };

export default function AdminOrganizationsPage() {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<OrgRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<{ org: OrgRow; status: "ACTIVE" | "SUSPENDED" | "BANNED" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((reset: boolean, nextCursor?: string | null) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (!reset && nextCursor) qs.set("cursor", nextCursor);
    api<{ items: OrgRow[]; nextCursor: string | null }>(`/admin/organizations?${qs.toString()}`)
      .then((r) => {
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setCursor(r.nextCursor);
      })
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => load(true), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function confirm() {
    if (!target) return;
    if (note.trim().length < 5) return toast("Add a short note.", { kind: "err" });
    setBusy(true);
    try {
      await api(`/admin/organizations/${target.org.id}/status`, { method: "POST", body: { status: target.status, note: note.trim() } });
      toast(`${target.org.displayName} set to ${target.status.toLowerCase()}.`);
      setTarget(null);
      setNote("");
      load(true);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col">
      <h1>Organizations</h1>
      <p className="sub">Suspending or banning a company hides its public page immediately (absence and refusal read the same, a plain 404).</p>
      <Field label="Search" htmlFor="admin-orgs-q">
        <input id="admin-orgs-q" className="in" placeholder="Company name" value={q} onChange={(e) => setQ(e.target.value)} data-testid="admin-orgs-search" />
      </Field>
      <div className="card">
        {loading && !items.length ? (
          <Skeleton h={200} />
        ) : !items.length ? (
          <Empty title="No matches" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Company</th>
                <th>Followers</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id} data-testid={`admin-org-row-${o.id}`}>
                  <td>
                    <Link href={`/companies/${o.slug}`} className="row sm">
                      <Avatar name={o.displayName} assetId={o.logoAssetId} size={26} />
                      <b>{o.displayName}</b>
                    </Link>
                  </td>
                  <td className="mono dim">{o.followerCount}</td>
                  <td>
                    <Chip kind={STATUS_KIND[o.status] ?? ""}>{o.status.toLowerCase()}</Chip>
                  </td>
                  <td>
                    {o.status === "ACTIVE" ? (
                      <div className="row">
                        <Button small kind="" onClick={() => setTarget({ org: o, status: "SUSPENDED" })}>
                          Suspend
                        </Button>
                        <Button small kind="d" onClick={() => setTarget({ org: o, status: "BANNED" })}>
                          Ban
                        </Button>
                      </div>
                    ) : (
                      <Button small kind="g" onClick={() => setTarget({ org: o, status: "ACTIVE" })}>
                        Reinstate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor ? (
          <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
            <button className="btn s" onClick={() => load(false, cursor)}>
              Load more
            </button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={target ? `${target.status === "ACTIVE" ? "Reinstate" : target.status === "SUSPENDED" ? "Suspend" : "Ban"} ${target.org.displayName}` : ""}
        footer={
          <>
            <Button kind="g" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button kind="p" onClick={confirm} loading={busy} data-testid="admin-org-status-confirm">
              Confirm
            </Button>
          </>
        }
      >
        <Field label="Note" htmlFor="admin-org-note">
          <textarea id="admin-org-note" className="in" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
