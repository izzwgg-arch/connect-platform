"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, FileText, Settings2, Search } from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { apiGet } from "../services/apiClient";
import { buildSearchCatalog, findSearchResults, OPEN_PERSONAL_SETTINGS_EVENT, type SearchResult } from "../lib/globalSearch";
import { SEARCH_NAVIGATION_EVENT } from "../hooks/useSearchNavigation";
import styles from "./GlobalSearch.module.css";

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [active, setActive] = useState(0);
  const [limit, setLimit] = useState(16);
  const [retry, setRetry] = useState(0);
  const [remote, setRemote] = useState<{ key: string; results?: SearchResult[]; unavailable?: string[]; failed?: boolean }>();
  const { user, tenantId, adminScope, backendJwtRole, can, permissionsHydrated, navVisibility } = useAppContext();
  const catalog = useMemo(() => permissionsHydrated ? buildSearchCatalog(can, backendJwtRole, navVisibility) : [], [can, backendJwtRole, permissionsHydrated, navVisibility]);
  const dataAccess = [can("can_view_tenant_chats"), can("can_view_tenant_call_history"), can("can_view_tenant_voicemails"), can("can_view_billing_invoices")].join(":");
  const scope = `${dataAccess}:${user.id}:${tenantId}:${adminScope}:${backendJwtRole}:${catalog.map(r => r.id).join(",")}`;
  const key = `${scope}:${query.trim()}:${retry}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const router = useRouter();
  const pathname = usePathname();
  const needsRecords = open && permissionsHydrated && query.trim().length >= 2 && (filter === "all" || filter === "record");
  const response = remote?.key === key ? remote : undefined;
  const matches = [...findSearchResults(catalog, query), ...(response?.results ?? []).filter(r => !r.navId || catalog.some(p => p.navId === r.navId))].filter(r => filter === "all" || r.kind === filter);
  const shown = matches.slice(0, limit);

  useEffect(() => { setOpen(false); setQuery(""); setRemote(undefined); }, [pathname, scope, can]);
  useEffect(() => { setActive(0); setLimit(16); }, [query, filter]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); input.current?.select(); setOpen(true); }
    };
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", shortcut);
    window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", shortcut); window.removeEventListener("pointerdown", outside); };
  }, []);
  useEffect(() => {
    if (!needsRecords) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiGet<{ results: SearchResult[]; unavailable?: string[] }>(`/search/global?${new URLSearchParams({ q: query.trim(), scope: adminScope })}`)
        .then(data => { if (!cancelled && currentKey.current === key) setRemote({ key, ...data }); })
        .catch(() => { if (!cancelled && currentKey.current === key) setRemote({ key, failed: true }); });
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [needsRecords, key, query, adminScope, can]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, open, id]);

  function choose(result: SearchResult) {
    setOpen(false);
    if (result.personalSection) window.dispatchEvent(new CustomEvent(OPEN_PERSONAL_SETTINGS_EVENT, { detail: { section: result.personalSection } }));
    else if (result.href?.startsWith("/") && !result.href.startsWith("//")) { router.push(result.href); window.dispatchEvent(new CustomEvent(SEARCH_NAVIGATION_EVENT, { detail: { href: result.href } })); }
  }
  return (
    <div className={`global-search ${styles.root}`} ref={root}>
      <div className={styles.field}>
        <input ref={input} className={`input global-search-input ${styles.input}`} value={query} maxLength={120}
          placeholder="Search pages, settings, people…" aria-label="Search Loopcom" role="combobox" aria-autocomplete="list"
          aria-expanded={open} aria-controls={id} aria-activedescendant={open && shown[active] ? `${id}-${active}` : undefined}
          onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }}
          onKeyDown={event => {
            if (event.key === "Escape") { setOpen(false); event.stopPropagation(); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActive(n => Math.max(0, Math.min(shown.length - 1, n + (event.key === "ArrowDown" ? 1 : -1)))); }
            if (event.key === "Enter" && open && shown[active]) { event.preventDefault(); choose(shown[active]); }
          }} />
        <span className={styles.shortcut}>Ctrl / ⌘ K</span>
      </div>
      {open && <div className={styles.results}>
        <div className={styles.filters}>{[["all", "All"], ["page", "Pages"], ["setting", "Settings"], ["record", "Records"]].map(([value, label]) => <button key={value} type="button" className={styles.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
        <div className={styles.list} id={id} role="listbox" aria-label="Search results">
          {shown.map((result, index) => { const Icon = result.kind === "setting" ? Settings2 : result.kind === "page" ? FileText : Search; return <button type="button" role="option" aria-selected={active === index} id={`${id}-${index}`} key={result.id} className={styles.item} onMouseEnter={() => setActive(index)} onClick={() => choose(result)}>
            <span className={styles.icon}><Icon size={16} /></span><span className={styles.copy}><span className={styles.title}>{result.title}</span><span className={styles.description}>{result.description}</span></span><ArrowUpRight size={14} aria-hidden="true" />
          </button>; })}
        </div>
        {matches.length > limit && <button className={styles.more} onClick={() => setLimit(n => n + 20)}>Show more results ({matches.length - limit})</button>}
        <div aria-live="polite">
          {needsRecords && !response && <div className={styles.notice}>Searching records…</div>}
          {(response?.failed || Boolean(response?.unavailable?.length)) && <div className={styles.notice}>Some records could not be searched. <button className={styles.retry} onClick={() => setRetry(n => n + 1)}>Try again</button></div>}
          {!shown.length && (!needsRecords || response) && <div className={styles.notice}>{!permissionsHydrated ? "Loading your permissions…" : query.trim().length < 2 && filter === "record" ? "Type at least two characters to search records." : "No matches in the areas you can access. Try a name, number or different words."}</div>}
        </div>
        {adminScope === "GLOBAL" && <div className={styles.notice}>Select a company to search its contacts, extensions, messages, CRM and voicemail.</div>}
        <div className={styles.footer}>Your permitted pages, settings and records · ↑ ↓ to move · Enter to open · Esc to close</div>
      </div>}
    </div>
  );
}
