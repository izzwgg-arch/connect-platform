"use client";

/**
 * "Whose order is this?" — one input that suggests register accounts as the
 * rep types (Izzy, 2026-09-08: "when I search a phone number, I get
 * suggestions, and it comes up"). Digits match any phone on the record,
 * letters match the name. Suggestions come from the CUSTOMER MIRROR
 * (`/supermarket/customers/search`), never the register — the register has
 * no search and bills per call.
 *
 * Keyboard-first, like the quick-add box: ↑/↓ rove, Enter picks the
 * highlighted account (or, with nothing highlighted, submits the typed
 * digits), Esc closes. The mouse works too.
 *
 * ⛔ An EMPTY list must say why. Before the mirror's first walk finishes
 * there is nothing to match, and "no matches" would read as "no such
 * customer" — the server sends `mirror.ready` + a count so the box can say
 * "still loading from the register" instead.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { Search } from "lucide-react";
import { apiGet } from "../../../services/apiClient";
import { useUiLanguage } from "../../../hooks/useUiLanguage";

export type CustomerHit = {
  posCustomerId: string;
  name: string;
  phones: string[];
  primaryPhone: string;
  address: string;
  city: string;
  route: string;
  onAccount: boolean;
  cardCount: number;
};

export const SM_TYPEAHEAD_PHRASES = [
  "Customer phone or name",
  "The customer list is still loading from the register",
  "accounts so far",
  "No account matches that",
  "Acct",
  "on account",
  "card on file",
  "cards on file",
] as string[];

export function formatPhone10(p: string): string {
  const d = String(p ?? "").replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

export function CustomerTypeahead({
  value,
  onChange,
  onPick,
  onEnter,
  placeholder,
  inputRef,
  autoFocus,
  disabled,
  boxStyle,
  inputStyle,
  minChars = 3,
  onBlurLookup,
}: {
  value: string;
  onChange: (v: string) => void;
  /** a suggestion was chosen (keyboard or mouse) */
  onPick: (hit: CustomerHit) => void;
  /** Enter with nothing highlighted — the typed text as-is */
  onEnter?: (typed: string) => void;
  placeholder?: string;
  inputRef?: MutableRefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  disabled?: boolean;
  boxStyle?: CSSProperties;
  inputStyle?: CSSProperties;
  minChars?: number;
  /** fires on blur when the text changed and nothing was picked */
  onBlurLookup?: (typed: string) => void;
}) {
  const { t } = useUiLanguage(SM_TYPEAHEAD_PHRASES);
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [mirror, setMirror] = useState<{ customers: number; ready: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const localRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? localRef;
  const pickedRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const term = value.trim();
  useEffect(() => {
    const digits = term.replace(/\D/g, "");
    const enough = digits.length >= minChars || term.replace(/[\d\s()+-]/g, "").length >= 2;
    if (!enough) {
      setHits([]);
      setSel(-1);
      setOpen(false);
      return;
    }
    let dead = false;
    const timer = setTimeout(() => {
      void apiGet<{ items: CustomerHit[]; mirror?: { customers: number; ready: boolean } }>(
        `/supermarket/customers/search?q=${encodeURIComponent(term)}`,
      )
        .then((res) => {
          if (dead) return;
          setHits(res.items ?? []);
          setMirror(res.mirror ?? null);
          setSel((res.items ?? []).length > 0 ? 0 : -1);
          setOpen(true);
        })
        .catch(() => {
          if (!dead) {
            setHits([]);
            setOpen(false);
          }
        });
    }, 110);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [term, minChars]);

  const pick = useCallback(
    (hit: CustomerHit) => {
      pickedRef.current = true;
      setOpen(false);
      setHits([]);
      onPick(hit);
    },
    [onPick],
  );

  // click-away closes the list (⛔ a pick registers on mousedown, before the
  // input blurs — otherwise the blur lookup fires with the OLD text)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const showList = open && term.length > 0;
  const loadingHint = mirror && !mirror.ready && hits.length === 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <div className="sm-fieldbox" style={{ flexWrap: "nowrap", ...boxStyle }}>
        <Search size={13} aria-hidden style={{ color: "var(--text-dim)", flexShrink: 0 }} />
        <input
          ref={ref}
          value={value}
          placeholder={placeholder ?? t("Customer phone or name")}
          aria-label={placeholder ?? t("Customer phone or name")}
          aria-autocomplete="list"
          aria-expanded={showList}
          disabled={disabled}
          onChange={(e) => {
            pickedRef.current = false;
            onChange(e.target.value);
          }}
          onFocus={() => {
            if (hits.length > 0) setOpen(true);
          }}
          onBlur={() => {
            // let a mousedown on an option land first
            setTimeout(() => {
              if (!pickedRef.current && onBlurLookup && value.trim()) onBlurLookup(value.trim());
            }, 150);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && hits.length > 0) {
              e.preventDefault();
              setOpen(true);
              setSel((s) => (s + 1) % hits.length);
            } else if (e.key === "ArrowUp" && hits.length > 0) {
              e.preventDefault();
              setSel((s) => (s <= 0 ? hits.length - 1 : s - 1));
            } else if (e.key === "Escape") {
              setOpen(false);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (showList && sel >= 0 && hits[sel]) pick(hits[sel]);
              else onEnter?.(value.trim());
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: 0,
            outline: "none",
            color: "inherit",
            font: "inherit",
            fontVariantNumeric: "tabular-nums",
            ...inputStyle,
          }}
        />
      </div>
      {showList && (hits.length > 0 || loadingHint || mirror) ? (
        <div className="sm-ta-dd" role="listbox" style={{ position: "absolute", left: 0, right: 0, zIndex: 30 }}>
          {hits.map((h, i) => (
            <div
              key={h.posCustomerId}
              role="option"
              aria-selected={i === sel}
              className={`sm-ta-opt${i === sel ? " sm-ta-sel" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <div className="sm-ta-nm">
                <b>
                  {h.name || t("Acct") + " " + h.posCustomerId}
                  <span style={{ fontWeight: 500, marginLeft: 8, color: "var(--text-dim)" }}>
                    {t("Acct")} {h.posCustomerId}
                  </span>
                </b>
                <span>
                  {h.phones.map(formatPhone10).join(" · ")}
                  {h.address ? ` · ${h.address}${h.city ? `, ${h.city}` : ""}` : ""}
                  {h.route ? ` · ${h.route}` : ""}
                </span>
              </div>
              <span className="sm-sku" style={{ whiteSpace: "nowrap" }}>
                {h.onAccount ? t("on account") : ""}
                {h.onAccount && h.cardCount > 0 ? " · " : ""}
                {h.cardCount === 1 ? `1 ${t("card on file")}` : h.cardCount > 1 ? `${h.cardCount} ${t("cards on file")}` : ""}
              </span>
              {i === sel ? <span className="sm-ta-enter">Enter</span> : null}
            </div>
          ))}
          {hits.length === 0 ? (
            <div className="sm-ta-opt" style={{ cursor: "default" }}>
              <span className="sm-sku">
                {loadingHint
                  ? `${t("The customer list is still loading from the register")} — ${mirror?.customers ?? 0} ${t("accounts so far")}`
                  : t("No account matches that")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
