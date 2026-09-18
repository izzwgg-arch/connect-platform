"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Dialog, Empty, Field, Skeleton, fmtDate, useToast } from "@/components/ui";

const TYPES = ["posts", "jobs", "listings", "rfqs", "events", "groups"] as const;
type ContentType = (typeof TYPES)[number];
type Row = { id: string; title: string; status?: string; createdAt: string };

export default function AdminContentPage() {
  const toast = useToast();
  const [type, setType] = useState<ContentType>("posts");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((reset: boolean, nextCursor?: string | null) => {
    setLoading(true);
    const qs = new URLSearchParams({ type });
    if (q) qs.set("q", q);
    if (!reset && nextCursor) qs.set("cursor", nextCursor);
    api<{ items: Row[]; nextCursor: string | null }>(`/admin/content?${qs.toString()}`)
      .then((r) => {
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setCursor(r.nextCursor);
      })
      .finally(() => setLoading(false));
  }, [type, q]);

  useEffect(() => {
    const t = setTimeout(() => load(true), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, q]);

  async function confirmRemove() {
    if (!removing) return;
    if (note.trim().length < 10) return toast("Write at least 10 characters.", { kind: "err" });
    setBusy(true);
    try {
      await api("/admin/content/remove", { method: "POST", body: { targetType: type === "posts" ? "post" : type.slice(0, -1), targetId: removing.id, note: note.trim() } });
      toast("Removed.");
      setRemoving(null);
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
      <h1>Content</h1>
      <p className="sub">Removing here opens (or reuses) a moderation case and actions it in one step.</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {TYPES.map((t) => (
          <button key={t} className={`chip ${type === t ? "sel" : ""}`} onClick={() => setType(t)} data-testid={`admin-content-tab-${t}`}>
            {t}
          </button>
        ))}
      </div>
      <Field label="Search" htmlFor="admin-content-q">
        <input id="admin-content-q" className="in" value={q} onChange={(e) => setQ(e.target.value)} data-testid="admin-content-search" />
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
                <th>Title</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} data-testid={`admin-content-row-${r.id}`}>
                  <td>
                    <b>{r.title}</b>
                    {r.status ? <small className="dim"> · {r.status}</small> : null}
                  </td>
                  <td className="dim">{fmtDate(r.createdAt)}</td>
                  <td>
                    <Button small kind="d" onClick={() => setRemoving(r)}>
                      Remove
                    </Button>
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
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove content"
        footer={
          <>
            <Button kind="g" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button kind="d" onClick={confirmRemove} loading={busy} data-testid="admin-content-remove-confirm">
              Remove
            </Button>
          </>
        }
      >
        <Field label="Note (required, at least 10 characters)" htmlFor="admin-content-note">
          <textarea id="admin-content-note" className="in" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
