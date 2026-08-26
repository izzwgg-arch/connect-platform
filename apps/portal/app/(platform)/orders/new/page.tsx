"use client";

/**
 * New order — the browser half of the order twin (mockup screen 3, third
 * frame): answering a call in the browser pops THIS page inside the caller's
 * account, cursor already in the item box. Also reachable from "＋ New order".
 *
 * ?phone=<caller> → the register account is looked up by that number and a
 * call-sourced draft is opened inside it. No phone → a blank order with the
 * lookup strip on top ("Whose order is this?").
 */

import "../supermarket.css";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { DraftReview } from "../OrdersDesk";

const SM_NEW_ORDER_PHRASES = [
  "New order", "Whose order is this?",
  "Ask for the phone number on the account. Just type — no clicking needed.",
  "Matches show as you type — Enter opens the account.",
  "No account — start a blank order",
  "Balance", "Card on file", "Uses WIC", "opened by the incoming call",
  "Looking up the account…",
] as string[];

function NewOrderInner() {
  const { t } = useUiLanguage(SM_NEW_ORDER_PHRASES);
  const params = useSearchParams();
  const router = useRouter();
  const phone = params?.get("phone") ?? "";
  const fromCall = params?.get("fromCall") === "1";
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lookupPhone, setLookupPhone] = useState("");
  const [looking, setLooking] = useState(Boolean(phone));
  const [acct, setAcct] = useState<{ name: string; posCustomerId: string | null; balanceCents: number | null } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const startedRef = useRef(false);

  const start = useCallback(
    async (phoneToUse: string) => {
      if (startedRef.current) return;
      startedRef.current = true;
      let name = "";
      let posCustomerId: string | null = null;
      let balanceCents: number | null = null;
      if (phoneToUse) {
        try {
          const found = await apiGet<any>(`/supermarket/lookup?phone=${encodeURIComponent(phoneToUse)}`);
          if (found?.found) {
            name = found.name ?? "";
            posCustomerId = found.posCustomerId ?? null;
            balanceCents = typeof found.balanceCents === "number" ? found.balanceCents : null;
          }
        } catch {
          /* unknown caller — the draft still opens */
        }
      }
      setAcct({ name, posCustomerId, balanceCents });
      try {
        const res = await apiPost<{ draft: { id: string } }>("/supermarket/drafts", {
          sourceType: "call",
          customerPhone: phoneToUse,
          customerName: name,
        });
        setDraftId(res.draft.id);
      } finally {
        setLooking(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (phone) void start(phone);
    else inputRef.current?.focus();
  }, [phone, start]);

  if (draftId) {
    return (
      <div className="sm-root sm-app">
        <div className="sm-content" style={{ minHeight: "auto", paddingBottom: 0 }}>
          <div className="sm-pagehead" style={{ marginBottom: ".4rem" }}>
            {acct?.name ? (
              <div className="sm-acct" style={{ marginBottom: 0 }}>
                <b>{acct.name}</b>
                {acct.posCustomerId ? <span>Acct {acct.posCustomerId}</span> : null}
                {acct.balanceCents !== null ? <span>{t("Balance")} <b>${(acct.balanceCents / 100).toFixed(2)}</b></span> : null}
              </div>
            ) : null}
            <span className="sm-spacer" />
            {fromCall ? <span className="sm-pill sm-info"><i />{t("opened by the incoming call")}</span> : null}
          </div>
        </div>
        <DraftReview draftId={draftId} />
      </div>
    );
  }

  return (
    <div className="sm-root sm-app">
      <div className="sm-content" style={{ minHeight: "auto", maxWidth: "30rem" }}>
        <div className="sm-pagehead"><h3>{t("New order")}</h3></div>
        {looking ? (
          <p className="sm-mut">{t("Looking up the account…")}</p>
        ) : (
          <div className="sm-card">
            <div className="sm-card-h">{t("Whose order is this?")}</div>
            <div className="sm-card-b">
              <p className="sm-mut" style={{ marginTop: 0 }}>{t("Ask for the phone number on the account. Just type — no clicking needed.")}</p>
              <div className="sm-fieldbox" style={{ borderColor: "var(--accent)", boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)" }}>
                <Search size={13} aria-hidden style={{ color: "var(--text-dim)" }} />
                <input
                  ref={inputRef}
                  value={lookupPhone}
                  inputMode="numeric"
                  onChange={(e) => setLookupPhone(e.target.value.replace(/[^\d() +-]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && lookupPhone.replace(/\D/g, "").length >= 10) {
                      router.replace(`/orders/new?phone=${encodeURIComponent(lookupPhone.replace(/\D/g, ""))}`);
                    }
                  }}
                  aria-label={t("Whose order is this?")}
                  style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit", fontVariantNumeric: "tabular-nums", fontSize: ".95rem" }}
                />
              </div>
              <p className="sm-mut">{t("Matches show as you type — Enter opens the account.")}</p>
              <button type="button" className="sm-btn sm-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => void start("")}>
                {t("No account — start a blank order")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function NewSupermarketOrderPage() {
  return (
    <PermissionGate
      permission={"can_view_supermarket_orders" as never}
      fallback={<div className="card" style={{ margin: 24, padding: 24 }}><p>This screen is switched off for your account.</p></div>}
    >
      <Suspense fallback={null}>
        <NewOrderInner />
      </Suspense>
    </PermissionGate>
  );
}
