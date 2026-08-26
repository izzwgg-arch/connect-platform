"use client";

/**
 * Order-twin body. Known caller → account strip + compact DraftReview with
 * the quick-add focused. Unknown caller (Phone Orders) → "Whose order is
 * this?" with the number field ALREADY holding keyboard focus — the rep asks
 * for the account's phone number and just types, no mouse (Izzy's spec).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { DraftReview } from "../OrdersDesk";

const SM_TWIN_PHRASES = [
  "Order", "Whose order is this?",
  "Ask for the phone number on the account. It's ready to take the digits — no clicking, just type.",
  "No account — start a new one",
  "Stays on screen until the order is put through",
  "Balance", "opened by the incoming call", "Looking up the account…",
] as string[];

export function TwinInner() {
  const { t } = useUiLanguage(SM_TWIN_PHRASES);
  const params = useSearchParams();
  const phone = params?.get("phone") ?? "";
  const [draftId, setDraftId] = useState<string | null>(null);
  const [acct, setAcct] = useState<{ name: string; posCustomerId: string | null; balanceCents: number | null } | null>(null);
  const [needLookup, setNeedLookup] = useState(false);
  const [lookupDigits, setLookupDigits] = useState("");
  const [busy, setBusy] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const startedRef = useRef(false);

  const open = useCallback(async (phoneToUse: string) => {
    setBusy(true);
    let name = "";
    let posCustomerId: string | null = null;
    let balanceCents: number | null = null;
    let found = false;
    if (phoneToUse) {
      try {
        const res = await apiGet<any>(`/supermarket/lookup?phone=${encodeURIComponent(phoneToUse)}`);
        if (res?.found) {
          found = true;
          name = res.name ?? "";
          posCustomerId = res.posCustomerId ?? null;
          balanceCents = typeof res.balanceCents === "number" ? res.balanceCents : null;
        }
      } catch {
        /* treated as unknown */
      }
    }
    if (!found && !startedRef.current) {
      // Unknown number on Phone Orders: the twin opens ready for the digits.
      setNeedLookup(true);
      setBusy(false);
      return;
    }
    startedRef.current = true;
    setAcct({ name, posCustomerId, balanceCents });
    setNeedLookup(false);
    try {
      const res = await apiPost<{ draft: { id: string } }>("/supermarket/drafts", {
        sourceType: "call",
        customerPhone: phoneToUse,
        customerName: name,
      });
      setDraftId(res.draft.id);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void open(phone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (needLookup) inputRef.current?.focus();
  }, [needLookup]);

  // ⛔ The twin must not disappear until the order is done — warn on close
  // while a draft is open and unsubmitted.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (draftId) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draftId]);

  if (draftId) {
    return (
      <div className="sm-root sm-app" style={{ fontSize: ".95em" }}>
        <div className="sm-content" style={{ minHeight: "auto", padding: ".7rem .8rem 0" }}>
          <div className="sm-pagehead" style={{ marginBottom: ".3rem" }}>
            {acct?.name ? (
              <div className="sm-acct" style={{ marginBottom: 0, padding: ".4rem .6rem" }}>
                <b>{acct.name}</b>
                {acct.posCustomerId ? <span>Acct {acct.posCustomerId}</span> : null}
                {acct.balanceCents !== null ? <span>{t("Balance")} <b>${(acct.balanceCents / 100).toFixed(2)}</b></span> : null}
              </div>
            ) : (
              <span className="sm-pill sm-info"><i />{t("opened by the incoming call")}</span>
            )}
          </div>
        </div>
        <DraftReview draftId={draftId} compact />
        <p className="sm-mut" style={{ textAlign: "center", fontSize: ".62rem", margin: ".2rem 0 .6rem" }}>
          {t("Stays on screen until the order is put through")}
        </p>
      </div>
    );
  }

  if (needLookup) {
    return (
      <div className="sm-root sm-app" style={{ padding: ".9rem .8rem" }}>
        <div style={{ fontWeight: 700, fontSize: ".92rem", marginBottom: ".3rem" }}>{t("Whose order is this?")}</div>
        <p className="sm-mut" style={{ marginTop: 0 }}>{t("Ask for the phone number on the account. It's ready to take the digits — no clicking, just type.")}</p>
        <div className="sm-fieldbox" style={{ borderColor: "var(--accent)", boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)", fontVariantNumeric: "tabular-nums" }}>
          <Search size={13} aria-hidden style={{ color: "var(--text-dim)" }} />
          <input
            ref={inputRef}
            value={lookupDigits}
            inputMode="numeric"
            autoFocus
            onChange={(e) => setLookupDigits(e.target.value.replace(/[^\d() +-]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && lookupDigits.replace(/\D/g, "").length >= 10) {
                void open(lookupDigits.replace(/\D/g, ""));
              }
            }}
            aria-label={t("Whose order is this?")}
            style={{ flex: 1, background: "transparent", border: 0, outline: "none", color: "inherit", font: "inherit", fontSize: ".95rem" }}
          />
        </div>
        <button
          type="button"
          className="sm-btn sm-ghost"
          style={{ width: "100%", justifyContent: "center", marginTop: ".6rem" }}
          onClick={() => {
            startedRef.current = true;
            setNeedLookup(false);
            void open("");
          }}
        >
          {t("No account — start a new one")}
        </button>
        <p className="sm-mut" style={{ textAlign: "center", fontSize: ".62rem", marginTop: ".6rem" }}>
          {t("Stays on screen until the order is put through")}
        </p>
      </div>
    );
  }

  return <p className="sm-mut" style={{ padding: "1rem" }}>{busy ? t("Looking up the account…") : null}</p>;
}
