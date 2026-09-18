"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Dialog, Empty, Menu, Skeleton, fmtDate, useToast } from "@/components/ui";
import type { PersonCard } from "@/components/graph/types";
import "@/components/graph/graph.css";

type Row = { connection: { id: string; acceptedAt: string | null }; person: PersonCard; relationship: string[]; lastContactAt: string | null };

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "customers", label: "Customers" },
  { key: "vendors", label: "Vendors" },
  { key: "worked_with", label: "Worked with" },
  { key: "referred", label: "Referred" },
  { key: "partners", label: "Partners" },
  { key: "loopcom", label: "Loopcom customers" },
];

const RELATIONSHIP_KINDS: Array<{ value: string; label: string }> = [
  { value: "CUSTOMER", label: "Customer" },
  { value: "VENDOR", label: "Vendor" },
  { value: "PURCHASED_FROM", label: "Purchased from" },
  { value: "SOLD_TO", label: "Sold to" },
  { value: "WORKED_WITH", label: "Worked with" },
  { value: "PARTNER", label: "Partner" },
  { value: "REFERRED", label: "Referred" },
  { value: "MENTOR", label: "Mentor" },
];

export default function ConnectionsPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [relPerson, setRelPerson] = useState<Row | null>(null);
  const [removeConn, setRemoveConn] = useState<Row | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 350);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ filter, limit: "25" });
        if (q) params.set("q", q);
        if (cursor) params.set("cursor", cursor);
        const r = await api<{ items: Row[]; nextCursor: string | null; total: number }>(`/connections?${params.toString()}`);
        setRows(r.items);
        setTotal(r.total);
        setNextCursor(r.nextCursor);
      } catch (e: any) {
        toast(e?.message ?? "Couldn't load your connections.", { kind: "err" });
      } finally {
        setLoading(false);
      }
    },
    [filter, q, toast],
  );

  useEffect(() => {
    setCursorStack([]);
    void load();
  }, [load]);

  useEffect(() => {
    api<{ counts: Record<string, number> }>("/connections/counts")
      .then((r) => setCounts(r.counts))
      .catch(() => undefined);
  }, [rows.length]);

  function next() {
    if (!nextCursor) return;
    setCursorStack((s) => [...s, nextCursor]);
    void load(nextCursor);
  }
  function prev() {
    setCursorStack((s) => {
      const copy = [...s];
      copy.pop();
      void load(copy[copy.length - 1]);
      return copy;
    });
  }

  async function exportCsv() {
    try {
      const res = await api<{ raw?: string }>("/connections/export.csv");
      const text = res.raw ?? "";
      const blob = new Blob([text], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "connections.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't export that.", { kind: "err" });
    }
  }

  async function removeConnection() {
    if (!removeConn) return;
    try {
      await api(`/connections/${removeConn.connection.id}`, { method: "DELETE" });
      setRows((s) => s.filter((r) => r.connection.id !== removeConn.connection.id));
      setTotal((t) => t - 1);
      toast("Connection removed.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't remove that connection.", { kind: "err" });
    } finally {
      setRemoveConn(null);
    }
  }

  async function block(personId: string, connId: string) {
    try {
      await api(`/people/${personId}/block`, { method: "POST" });
      setRows((s) => s.filter((r) => r.connection.id !== connId));
      toast("Blocked.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't block that person.", { kind: "err" });
    }
  }

  return (
    <AppShell title="Connections">
      <div className="card" style={{ gridColumn: "1/-1" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ fontSize: 18 }}>{total} connections</h2>
            <span className="sm dim">Sorted by recently added</span>
          </div>
          <div className="row">
            <input className="in" style={{ width: 240 }} placeholder="Search connections" value={qInput} onChange={(e) => setQInput(e.target.value)} data-testid="connections-search" />
            <Button kind="g" icon="dl" onClick={() => void exportCsv()} data-testid="connections-export">
              Export CSV
            </Button>
          </div>
        </div>
        <div className="pill-row" style={{ marginBottom: 12 }}>
          {FILTERS.map((f) => (
            <Chip key={f.key} kind={filter === f.key ? "sel" : ""} onClick={() => setFilter(f.key)}>
              {f.label} · {counts[f.key] ?? 0}
            </Chip>
          ))}
        </div>

        {loading ? (
          <div className="list">
            <Skeleton h={44} />
            <Skeleton h={44} />
            <Skeleton h={44} />
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No connections match" text={q || filter !== "all" ? "Try a different search or filter." : "Send your first connection request from My network."} />
        ) : (
          <div className="tblwrap">
            <table className="tbl" data-testid="connections-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="ph-hide">Company</th>
                  <th>Relationship</th>
                  <th className="ph-hide">Connected</th>
                  <th className="ph-hide">Last contact</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.connection.id} data-testid={`connections-row-${r.person.id}`}>
                    <td>
                      <div className="row">
                        <Link href={`/people/${r.person.username}`}>
                          <Avatar name={r.person.name} assetId={r.person.avatarAssetId} size={32} />
                        </Link>
                        <Link href={`/people/${r.person.username}`}>
                          <b>{r.person.name}</b>
                        </Link>
                      </div>
                    </td>
                    <td className="dim ph-hide">{r.person.primaryOrg?.displayName ?? r.person.headline ?? "—"}</td>
                    <td>
                      <div className="rel-chip-row">
                        {r.relationship.length ? r.relationship.map((k) => <Chip key={k} kind="ac">{RELATIONSHIP_KINDS.find((x) => x.value === k)?.label ?? k}</Chip>) : <span className="dim sm">—</span>}
                      </div>
                    </td>
                    <td className="dim mono ph-hide">{r.connection.acceptedAt ? fmtDate(r.connection.acceptedAt) : "—"}</td>
                    <td className="dim ph-hide">{r.lastContactAt ? fmtDate(r.lastContactAt) : "—"}</td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <Button small icon="msg" href={`/messages/new?to=${r.person.id}`} data-testid={`connections-message-${r.person.id}`}>
                          Message
                        </Button>
                        <Menu label={`More for ${r.person.name}`}>
                          <button type="button" onClick={() => setRelPerson(r)} data-testid={`connections-relationship-${r.person.id}`}>
                            Relationship tags
                          </button>
                          <Link href={`/crm?person=${r.person.id}`} data-testid={`connections-note-${r.person.id}`}>
                            Add note
                          </Link>
                          <button type="button" onClick={() => setRemoveConn(r)} data-testid={`connections-remove-${r.person.id}`}>
                            Remove connection
                          </button>
                          <button type="button" onClick={() => void block(r.person.id, r.connection.id)} data-testid={`connections-block-${r.person.id}`}>
                            Block
                          </button>
                        </Menu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row sm dim" style={{ justifyContent: "space-between", marginTop: 10 }}>
          <span>Showing {rows.length} of {total}</span>
          <div className="row">
            <Button kind="g" small disabled={cursorStack.length === 0} onClick={prev} data-testid="connections-prev">
              Previous
            </Button>
            <Button small disabled={!nextCursor} onClick={next} data-testid="connections-next">
              Next
            </Button>
          </div>
        </div>
      </div>

      {relPerson ? <RelationshipDialog row={relPerson} onClose={() => setRelPerson(null)} onSaved={(kinds) => setRows((s) => s.map((r) => (r.connection.id === relPerson.connection.id ? { ...r, relationship: kinds } : r)))} /> : null}

      <Dialog open={!!removeConn} onClose={() => setRemoveConn(null)} title="Remove connection" footer={
        <>
          <Button kind="g" onClick={() => setRemoveConn(null)}>Cancel</Button>
          <Button kind="d" onClick={() => void removeConnection()} data-testid="connections-remove-confirm">Remove</Button>
        </>
      }>
        <p className="sm">Remove {removeConn?.person.name} from your connections? They won't be notified.</p>
      </Dialog>
    </AppShell>
  );
}

function RelationshipDialog({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: (kinds: string[]) => void }) {
  const toast = useToast();
  const [kinds, setKinds] = useState<string[]>(row.relationship);
  const [busy, setBusy] = useState(false);

  function toggle(kind: string) {
    setKinds((s) => (s.includes(kind) ? s.filter((k) => k !== kind) : [...s, kind]));
  }

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ kinds: Array<{ kind: string; mutual: boolean }> }>(`/people/${row.person.id}/relationship`, { method: "PUT", body: { kinds } });
      onSaved(r.kinds.map((k) => k.kind));
      toast("Relationship updated.");
      onClose();
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Relationship with ${row.person.name}`}
      footer={
        <>
          <Button kind="g" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="p" loading={busy} onClick={() => void save()} data-testid="relationship-save">
            Save
          </Button>
        </>
      }
    >
      <p className="sm dim">Private to you unless they tag you back with the matching kind.</p>
      <div className="list sm" style={{ marginTop: 10 }}>
        {RELATIONSHIP_KINDS.map((k) => (
          <label key={k.value} className="li" style={{ alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={kinds.includes(k.value)} onChange={() => toggle(k.value)} data-testid={`relationship-kind-${k.value}`} />
            <span>{k.label}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
