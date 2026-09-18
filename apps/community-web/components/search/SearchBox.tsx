"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Avatar, Icon } from "@/components/ui";

type PersonSuggestion = { kind: "person"; id: string; name: string; avatarAssetId: string | null; sub: string | null; href: string };
type OrgSuggestion = { kind: "organization"; id: string; name: string; avatarAssetId: string | null; sub: string | null; href: string };
type QuerySuggestion = { kind: "query"; text: string };
type Suggestion = PersonSuggestion | OrgSuggestion | QuerySuggestion;

/**
 * Autocomplete search input backed by GET /search/suggest. Standalone and
 * exported so it can be dropped anywhere (a page, a dialog, an @mention
 * picker); the top bar's own inline search box can adopt it later without
 * changing this component.
 */
export function SearchBox({
  defaultValue = "",
  placeholder = "Search people, businesses, jobs, RFQs…",
  onSubmit,
  autoFocus,
  testId = "searchbox",
}: {
  defaultValue?: string;
  placeholder?: string;
  onSubmit: (q: string) => void;
  autoFocus?: boolean;
  testId?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setValue(defaultValue), [defaultValue]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const fetchSuggestions = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setItems([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api<{ people: any[]; organizations: any[]; queries: string[] }>(`/search/suggest?q=${encodeURIComponent(q)}`);
        const out: Suggestion[] = [
          ...r.people.map((p): PersonSuggestion => ({ kind: "person", id: p.id, name: p.name, avatarAssetId: p.avatarAssetId, sub: p.headline, href: `/people/${p.username}` })),
          ...r.organizations.map((o): OrgSuggestion => ({ kind: "organization", id: o.id, name: o.displayName, avatarAssetId: o.logoAssetId, sub: o.industry, href: `/companies/${o.slug}` })),
          ...r.queries.map((q2): QuerySuggestion => ({ kind: "query", text: q2 })),
        ];
        setItems(out);
        setActive(-1);
      } catch {
        setItems([]);
      }
    }, 200);
  }, []);

  function submit(q: string) {
    setOpen(false);
    if (q.trim()) onSubmit(q.trim());
  }

  function go(s: PersonSuggestion | OrgSuggestion) {
    setOpen(false);
    router.push(s.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || !items.length) {
      if (e.key === "Enter") submit(value);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = active >= 0 ? items[active] : null;
      if (!it) submit(value);
      else if (it.kind === "query") submit(it.text);
      else go(it);
    }
  }

  return (
    <div className="search-box" ref={boxRef}>
      <form
        role="search"
        className="search-box-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
      >
        <Icon name="search" />
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            fetchSuggestions(e.target.value);
          }}
          onFocus={() => value && items.length && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-label="Search"
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
          data-testid={`${testId}-input`}
        />
        <button type="submit" className="ib" aria-label="Search" data-testid={`${testId}-submit`}>
          <Icon name="arrow" />
        </button>
      </form>
      {open && items.length > 0 ? (
        <div className="search-box-drop" role="listbox" data-testid={`${testId}-suggestions`}>
          {items.map((it, i) => (
            <button
              key={it.kind === "query" ? `q-${it.text}` : `${it.kind}-${it.id}`}
              type="button"
              role="option"
              aria-selected={active === i}
              className={`search-box-item ${active === i ? "on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (it.kind === "query" ? submit(it.text) : go(it))}
              data-testid={`${testId}-suggestion-${i}`}
            >
              {it.kind === "query" ? (
                <>
                  <Icon name="clock" />
                  <span>{it.text}</span>
                </>
              ) : (
                <>
                  <Avatar name={it.name} assetId={it.avatarAssetId} size={26} square={it.kind === "organization"} />
                  <span className="t">
                    <b>{it.name}</b>
                    {it.sub ? <small>{it.sub}</small> : null}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
