"use client";

/* Mockup 2 — Customers. Every customer, their plan, price, next charge, card and
   standing. The two conditions that silently break a customer today (billing day
   1, and no billing email) are shown as problems on the row itself. */

import { useMemo, useState } from "react";
import Link from "next/link";
import { BillingNav, Pill, SearchBox, asList, money, ordinal, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents?: number;
  billingSettings?: {
    billingDayOfMonth?: number;
    billingEmail?: string | null;
    autoBillingEnabled?: boolean;
    extensionPriceCents?: number;
    billingPlanId?: string | null;
  } | null;
  paymentMethods?: Array<{ id: string; brand?: string | null; last4?: string | null; isDefault?: boolean }>;
  invoices?: Array<{ id: string; status: string; balanceDueCents: number }>;
};

type Filter = "all" | "no-card" | "attention";

/** ⛔ A tenant with no billing settings at all reported day 0, and `ordinal(0)`
    falls back to 1 — so the worst accounts rendered as a calm, unstyled "1st"
    while genuine day-1 accounts got a red pill. On live data that was 19
    accounts drawn as healthy against 15 flagged. Never infer the billing day;
    absent is its own state. Module scope so every reader shares one rule. */
function billingDayOf(t: TenantRow): number | null {
  const raw = t.billingSettings ? Number(t.billingSettings.billingDayOfMonth) : NaN;
  return Number.isFinite(raw) && raw >= 1 ? raw : null;
}

export default function BillingCustomersPage() {
  const { data, error, loading } = useApi<TenantRow[]>(
    "/admin/billing/platform/tenants",
    (raw) => asList<TenantRow>(raw, "tenants"),
  );
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const list = data || [];
    const needle = q.trim().toLowerCase();
    return list.filter((t) => {
      if (needle && !String(t.name || "").toLowerCase().includes(needle)) return false;
      const cards = t.paymentMethods || [];
      const s = t.billingSettings;
      if (filter === "no-card") return cards.length === 0;
      if (filter === "attention") {
        const day = billingDayOf(t);
        return (
          cards.length === 0 ||
          !String(s?.billingEmail || "").trim() ||
          day === null ||
          day === 1 ||
          Number(t.balanceDueCents || 0) > 0
        );
      }
      return true;
    });
  }, [data, q, filter]);

  const stats = useMemo(() => {
    const list = data || [];
    return {
      total: list.length,
      withEmail: list.filter((t) => String(t.billingSettings?.billingEmail || "").trim()).length,
      noCard: list.filter((t) => (t.paymentMethods || []).length === 0).length,
      day1: list.filter((t) => billingDayOf(t) === 1).length,
      notSetUp: list.filter((t) => billingDayOf(t) === null).length,
    };
  }, [data]);

  return (
    <div className="cbill">
      <BillingNav current="customers" />
      <div className="cbill-head">
        <div>
          <h2>Customers</h2>
          <div className="cbill-sub">
            <span>{stats.total} companies</span>
            <span>·</span>
            <span>{stats.withEmail} with a billing email</span>
            <span>·</span>
            <span>{stats.noCard} missing a card</span>
            {stats.day1 + stats.notSetUp > 0 && (
              <>
                <span>·</span>
                <span style={{ color: "var(--cb-crit)" }}>
                  {stats.day1 + stats.notSetUp} with no real billing day
                </span>
              </>
            )}
          </div>
        </div>
        <div className="cbill-toolbar">
          <SearchBox value={q} onChange={setQ} placeholder="Search customers…" label="Search customers" />
          <div className="cbill-seg">
            <button type="button" data-on={filter === "all"} onClick={() => setFilter("all")}>All</button>
            <button type="button" data-on={filter === "no-card"} onClick={() => setFilter("no-card")}>Missing a card</button>
            <button type="button" data-on={filter === "attention"} onClick={() => setFilter("attention")}>Needs attention</button>
          </div>
        </div>
      </div>

      {stats.day1 + stats.notSetUp > 0 && (
        <div className="cbill-banner warn">
          <span>
            <strong>
              {stats.day1 + stats.notSetUp} customers have no billing day anyone chose
            </strong>{" "}
            — {stats.day1} sitting on the 1st, the default, and {stats.notSetUp} with no billing
            setup at all. Until that is a real day, their monthly cycle does not line up with
            anything they bought. Open a customer to change it.
          </span>
        </div>
      )}

      {error && <div className="cbill-banner bad">{error}</div>}
      {loading && <p className="cbill-sub">Loading customers…</p>}

      {!loading && !error && (
        <section className="cbill-card">
          <div className="cbill-table-wrap">
            <table className="cbill-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Billing day</th>
                  <th>Card</th>
                  <th>Billing email</th>
                  <th className="r">Owed now</th>
                  <th className="r">Standing</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: "var(--cb-muted)" }}>
                      No customers match.
                    </td>
                  </tr>
                )}
                {rows.map((t) => {
                  const s = t.billingSettings;
                  const cards = t.paymentMethods || [];
                  const card = cards.find((c) => c.isDefault) || cards[0];
                  const email = String(s?.billingEmail || "").trim();
                  const owed = Number(t.balanceDueCents || 0);
                  const day = billingDayOf(t);
                  const notCharging = s?.autoBillingEnabled === false;
                  return (
                    <tr key={t.id}>
                      <td>
                        <Link href={`/admin/billing/customer/${t.id}`}>{t.name || "(no name)"}</Link>
                        {/* Several companies share a name — there are two "Agent"
                            and two "KJFD" — so the row needs something else to
                            tell them apart. */}
                        <div className="cbill-rowsub">{t.id.slice(-6)}</div>
                      </td>
                      <td>
                        {day === null ? (
                          <Pill tone="bad">Not set up</Pill>
                        ) : day === 1 ? (
                          <Pill tone="warn">1st — default</Pill>
                        ) : (
                          <span className="n">{ordinal(day)}</span>
                        )}
                      </td>
                      <td>
                        {card ? (
                          <Pill tone="ok">{`${card.brand || "Card"} ····${card.last4 || "????"}`}</Pill>
                        ) : (
                          <Pill tone="bad">None</Pill>
                        )}
                      </td>
                      <td>
                        {email ? (
                          <span style={{ fontSize: 12.5 }}>{email}</span>
                        ) : (
                          <Pill tone="warn">Not set</Pill>
                        )}
                      </td>
                      <td className="r n">{owed > 0 ? money(owed) : "—"}</td>
                      <td className="r">
                        {owed > 0 ? (
                          <Pill tone="bad">Owes money</Pill>
                        ) : !card ? (
                          <Pill tone="bad">Cannot charge</Pill>
                        ) : notCharging ? (
                          <Pill tone="warn">Not collecting</Pill>
                        ) : (
                          <Pill tone="ok">Good</Pill>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
