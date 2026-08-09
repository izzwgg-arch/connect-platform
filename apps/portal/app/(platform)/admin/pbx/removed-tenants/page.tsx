"use client";

/* Customers whose PBX tenant was deleted.
   Deleting a tenant on VitalPBX used to leave the whole Connect company behind
   — users who could still sign in, billing that still counted them, and a link
   record still claiming they were connected. This is where that gets closed
   out, in two deliberate steps so a bad answer from the PBX can never destroy
   a live customer. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../../../../../services/apiClient";
import "../../billing/customer/customerBilling.css";

type Pending = {
  tenantId: string;
  name: string;
  pbxTenantId: string;
  hasCompletedPayment: boolean;
  users: number;
  invoices: number;
  paymentMethods: number;
};

type Removed = {
  id: string;
  name: string;
  pbxRemovedAt: string | null;
  archivedAt: string | null;
};

type Payload = {
  maxAutoRemovals: number;
  pending: Pending[];
  removed: Removed[];
};

function errText(e: any, fallback: string): string {
  return e?.body?.detail || e?.body?.message || e?.body?.error || e?.message || fallback;
}

function when(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function RemovedTenantsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await apiGet<Payload>("/admin/pbx/removed-tenants"));
    } catch (e: any) {
      setError(errText(e, "Could not check the phone system."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = data?.pending || [];
  const chosen = useMemo(() => pending.filter((p) => picked[p.tenantId]), [pending, picked]);
  const erasable = (data?.removed || []).filter((r) => !r.archivedAt);
  const kept = (data?.removed || []).filter((r) => r.archivedAt);

  const confirm = async () => {
    if (chosen.length === 0) return;
    setBusy("confirm");
    setError("");
    setNote("");
    try {
      const res: any = await apiPost("/admin/pbx/removed-tenants/confirm", {
        tenantIds: chosen.map((c) => c.tenantId),
      });
      setNote(
        `${(res?.marked || []).length} closed out. They are out of every list and will not be billed again.`,
      );
      setPicked({});
      await load();
    } catch (e: any) {
      setError(errText(e, "Nothing was changed."));
    } finally {
      setBusy("");
    }
  };

  const erase = async (r: Removed) => {
    setBusy(r.id);
    setError("");
    setNote("");
    try {
      await apiPost(`/admin/pbx/removed-tenants/${r.id}/erase`, {});
      setNote(`${r.name} and everything belonging to it has been deleted.`);
      await load();
    } catch (e: any) {
      setError(errText(e, "Nothing was deleted."));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="cbill">
      <div className="cbill-head">
        <div>
          <h2>Customers deleted on the phone system</h2>
          <div className="cbill-sub">
            <span>
              When a tenant is deleted on the PBX, its Connect company is closed out here — users,
              extensions, numbers, history and billing
            </span>
          </div>
        </div>
        <div className="cbill-toolbar">
          <button className="cbill-btn" onClick={() => void load()} disabled={loading}>
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>

      {error && <div className="cbill-banner bad">{error}</div>}
      {note && <div className="cbill-banner ok">{note}</div>}

      {!loading && pending.length === 0 && erasable.length === 0 && (
        <div className="cbill-banner ok">
          Every Connect company matches a live tenant on the phone system. Nothing to do.
        </div>
      )}

      {pending.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Waiting to be closed out</h3>
            <span className="hint">
              nothing is deleted by this step — they simply stop counting anywhere
            </span>
          </div>

          {pending.length > (data?.maxAutoRemovals ?? 3) && (
            <div style={{ padding: "12px 15px 0" }}>
              <div className="cbill-banner warn">
                <span>
                  <strong>{pending.length} companies at once is more than Connect will do on its own.</strong>{" "}
                  A sweep this large is a broken answer from the phone system until proven otherwise,
                  so it is waiting for you. Check the names below are really gone before confirming.
                </span>
              </div>
            </div>
          )}

          <div className="cbill-table-wrap">
            <table className="cbill-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={chosen.length === pending.length && pending.length > 0}
                      onChange={(e) =>
                        setPicked(
                          e.target.checked
                            ? Object.fromEntries(pending.map((p) => [p.tenantId, true]))
                            : {},
                        )
                      }
                    />
                  </th>
                  <th>Customer</th>
                  <th>Was</th>
                  <th className="r">Users</th>
                  <th className="r">Invoices</th>
                  <th className="r">Cards</th>
                  <th className="r">What happens</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.tenantId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.name}`}
                        checked={Boolean(picked[p.tenantId])}
                        onChange={(e) =>
                          setPicked((prev) => ({ ...prev, [p.tenantId]: e.target.checked }))
                        }
                      />
                    </td>
                    <td>
                      {p.name}
                      <div className="cbill-rowsub">{p.tenantId.slice(-6)}</div>
                    </td>
                    <td className="n">T{p.pbxTenantId}</td>
                    <td className="r n">{p.users}</td>
                    <td className="r n">{p.invoices}</td>
                    <td className="r n">{p.paymentMethods}</td>
                    <td className="r">
                      {p.hasCompletedPayment ? (
                        <span className="cbill-pill warn">Books kept</span>
                      ) : (
                        <span className="cbill-pill bad">Everything deleted</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="cbill-actions" style={{ justifyContent: "flex-end" }}>
            <span className="cbill-sub" style={{ marginRight: "auto" }}>
              {chosen.length === 0
                ? "Pick the companies to close out."
                : `${chosen.length} selected · ${chosen.filter((c) => c.hasCompletedPayment).length} keep their books`}
            </span>
            <button
              className="cbill-btn primary"
              disabled={chosen.length === 0 || busy === "confirm"}
              onClick={() => void confirm()}
            >
              {busy === "confirm" ? "Closing out…" : `Close out ${chosen.length || ""}`.trim()}
            </button>
          </div>
        </section>
      )}

      {erasable.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Ready to delete permanently</h3>
            <span className="hint">already closed out · no payment was ever completed</span>
          </div>
          {erasable.map((r) => (
            <div className="cbill-att" key={r.id}>
              <div className="cbill-att-i bad">!</div>
              <div className="cbill-att-tx">
                <span className="h">{r.name}</span>
                <span className="d">
                  Closed out {when(r.pbxRemovedAt)} · deleting removes the users, extensions,
                  numbers, call history, voicemail, contacts and messages. This cannot be undone.
                </span>
              </div>
              <button
                className="cbill-btn danger"
                disabled={busy === r.id}
                onClick={() => void erase(r)}
              >
                {busy === r.id ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          ))}
        </section>
      )}

      {kept.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Closed out, records kept</h3>
            <span className="hint">these customers completed payments, so their books stay</span>
          </div>
          {kept.map((r) => (
            <div className="cbill-att" key={r.id}>
              <div className="cbill-att-i warn">$</div>
              <div className="cbill-att-tx">
                <span className="h">{r.name}</span>
                <span className="d">
                  Closed out {when(r.pbxRemovedAt)} · invoices and payments kept, everything else
                  switched off
                </span>
              </div>
              <span className="cbill-pill off">Kept</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
