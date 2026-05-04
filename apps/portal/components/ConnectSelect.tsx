"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { ViewportDropdown } from "./ViewportDropdown";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectOptionGroup = {
  label: string;
  options: SelectOption[];
};

type ConnectSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectOptionGroup[];
  placeholder?: string;
  disabled?: boolean;
  /** Auto-enables search when there are more than this many options. Default: 8 */
  searchThreshold?: number;
  searchable?: boolean;
  className?: string;
  style?: CSSProperties;
  /** "sm" = compact filter bar height; "md" = standard form height (default) */
  size?: "sm" | "md";
  /** Dropdown panel width in px. Defaults to matching trigger width (min 180). */
  dropdownWidth?: number;
  id?: string;
};

const AUTO_SEARCH_THRESHOLD = 8;

export function ConnectSelect({
  value,
  onChange,
  options = [],
  groups,
  placeholder = "Select…",
  disabled = false,
  searchThreshold = AUTO_SEARCH_THRESHOLD,
  searchable: searchableProp,
  className = "",
  style,
  size = "md",
  dropdownWidth,
  id,
}: ConnectSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Flatten all options for keyboard nav and search
  const allOptions = useMemo<SelectOption[]>(() => {
    if (groups) return groups.flatMap((g) => g.options);
    return options;
  }, [groups, options]);

  const totalOptions = allOptions.length;
  const showSearch = searchableProp ?? totalOptions > searchThreshold;

  const filtered = useMemo<SelectOption[]>(() => {
    if (!search.trim()) return allOptions;
    const q = search.trim().toLowerCase();
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, search]);

  const filteredGroups = useMemo<SelectOptionGroup[] | null>(() => {
    if (!groups) return null;
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter((o) => o.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, search]);

  const selectedLabel = useMemo(() => {
    const found = allOptions.find((o) => o.value === value);
    return found?.label ?? placeholder;
  }, [allOptions, value, placeholder]);

  const isPlaceholder = !allOptions.some((o) => o.value === value);

  useEffect(() => {
    setHighlight(0);
  }, [open, search]);

  useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => {
        if (showSearch) searchRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
  }, [open, showSearch]);

  const close = useCallback(() => {
    setOpen(false);
    setSearch("");
    triggerRef.current?.focus();
  }, []);

  const pick = useCallback(
    (optValue: string) => {
      onChange(optValue);
      close();
    },
    [close, onChange],
  );

  const onTriggerKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
    },
    [],
  );

  const onPanelKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = filtered[highlight];
        if (opt && !opt.disabled) pick(opt.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [close, filtered, highlight, pick],
  );

  // Measure trigger for width
  const [triggerWidth, setTriggerWidth] = useState<number>(180);
  useEffect(() => {
    if (!open) return;
    const w = triggerRef.current?.getBoundingClientRect().width ?? 180;
    setTriggerWidth(Math.max(180, w));
  }, [open]);

  const resolvedWidth = dropdownWidth ?? triggerWidth;

  const sm = size === "sm";

  return (
    <>
      <style>{CSS}</style>
      <div
        className={`cs-wrap ${sm ? "cs-sm" : "cs-md"} ${disabled ? "cs-disabled" : ""} ${className}`}
        style={style}
      >
        <button
          ref={triggerRef}
          id={id}
          type="button"
          className={`cs-trigger ${isPlaceholder ? "cs-trigger-placeholder" : ""}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => !disabled && setOpen((v) => !v)}
          onKeyDown={onTriggerKeyDown}
        >
          <span className="cs-trigger-label">{selectedLabel}</span>
          <ChevronDown
            className="cs-chevron"
            size={sm ? 13 : 15}
            strokeWidth={2.2}
            data-open={open ? "true" : "false"}
          />
        </button>

        <ViewportDropdown
          open={open}
          triggerRef={triggerRef}
          onClose={close}
          width={resolvedWidth}
          sideOffset={5}
          className="cs-panel"
        >
          <div
            className="cs-panel-inner"
            role="listbox"
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
          >
            {showSearch && (
              <label className="cs-search-wrap">
                <Search size={13} strokeWidth={2} className="cs-search-icon" />
                <input
                  ref={searchRef}
                  className="cs-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  autoComplete="off"
                />
              </label>
            )}

            <div className="cs-list">
              {filteredGroups
                ? filteredGroups.map((group) => (
                    <div key={group.label} className="cs-group">
                      <div className="cs-group-label">{group.label}</div>
                      {group.options.map((opt) => (
                        <OptionRow
                          key={opt.value}
                          opt={opt}
                          selected={opt.value === value}
                          highlighted={filtered.indexOf(opt) === highlight}
                          onMouseEnter={() =>
                            setHighlight(filtered.indexOf(opt))
                          }
                          onSelect={pick}
                        />
                      ))}
                    </div>
                  ))
                : filtered.map((opt, i) => (
                    <OptionRow
                      key={opt.value}
                      opt={opt}
                      selected={opt.value === value}
                      highlighted={i === highlight}
                      onMouseEnter={() => setHighlight(i)}
                      onSelect={pick}
                    />
                  ))}

              {filtered.length === 0 && (
                <div className="cs-empty">No options match</div>
              )}
            </div>
          </div>
        </ViewportDropdown>
      </div>
    </>
  );
}

function OptionRow({
  opt,
  selected,
  highlighted,
  onMouseEnter,
  onSelect,
}: {
  opt: SelectOption;
  selected: boolean;
  highlighted: boolean;
  onMouseEnter: () => void;
  onSelect: (value: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={opt.disabled}
      className={`cs-option ${selected ? "cs-option-selected" : ""} ${highlighted ? "cs-option-highlighted" : ""} ${opt.disabled ? "cs-option-disabled" : ""}`}
      onMouseEnter={onMouseEnter}
      onClick={() => !opt.disabled && onSelect(opt.value)}
    >
      <span className="cs-option-label">{opt.label}</span>
      {selected && (
        <Check className="cs-option-check" size={14} strokeWidth={2.5} />
      )}
    </button>
  );
}

const CSS = `
.cs-wrap { position: relative; display: inline-flex; flex-direction: column; min-width: 0; }
.cs-wrap.cs-md { min-width: 160px; }
.cs-wrap.cs-sm { min-width: 120px; }

.cs-trigger {
  display: inline-flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; border: 1px solid var(--border, rgba(148,163,184,.22));
  background: var(--panel-2, rgba(15,23,42,.72)); color: var(--text, #e1e9f1);
  border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 500;
  transition: border-color .14s ease, background .14s ease, box-shadow .14s ease;
  outline: none; text-align: left; white-space: nowrap; overflow: hidden;
}
.cs-md .cs-trigger { padding: 8px 10px 8px 12px; min-height: 36px; }
.cs-sm .cs-trigger { padding: 5px 8px 5px 10px; min-height: 29px; font-size: 12px; }

.cs-trigger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent, #22a8ff) 50%, var(--border, rgba(148,163,184,.22)));
  background: color-mix(in srgb, var(--panel-2, rgba(15,23,42,.72)) 90%, var(--accent, #22a8ff) 10%);
}
.cs-trigger:focus-visible {
  border-color: var(--accent, #22a8ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #22a8ff) 22%, transparent);
}
.cs-trigger[aria-expanded="true"] {
  border-color: color-mix(in srgb, var(--accent, #22a8ff) 60%, var(--border, rgba(148,163,184,.22)));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #22a8ff) 18%, transparent);
}
.cs-disabled .cs-trigger { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
.cs-trigger-placeholder .cs-trigger-label { color: var(--text-dim, #8ea0b2); }
.cs-trigger-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cs-chevron { flex-shrink: 0; color: var(--text-dim, #8ea0b2); transition: transform .18s ease; }
.cs-chevron[data-open="true"] { transform: rotate(180deg); }

/* Panel — inherits from ViewportDropdown */
.cs-panel { background: var(--panel, #141f2b) !important; border: 1px solid var(--border, rgba(148,163,184,.22)) !important; border-radius: 12px !important; box-shadow: 0 16px 48px rgba(0,0,0,.45) !important; backdrop-filter: blur(16px); overflow: hidden !important; padding: 0 !important; }
:root[data-theme="light"] .cs-panel { background: #fff !important; border-color: rgba(15,23,42,.12) !important; box-shadow: 0 12px 40px rgba(0,0,0,.12) !important; }

.cs-panel-inner { display: flex; flex-direction: column; }

.cs-search-wrap {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 10px; border-bottom: 1px solid var(--border, rgba(148,163,184,.18));
  background: color-mix(in srgb, var(--panel-2, rgba(15,23,42,.7)) 80%, transparent);
}
.cs-search-icon { color: var(--text-dim, #8ea0b2); flex-shrink: 0; }
.cs-search { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text, #e1e9f1); font-size: 12px; min-width: 0; }
.cs-search::placeholder { color: var(--text-dim, #8ea0b2); }

.cs-list { padding: 4px; max-height: 260px; overflow-y: auto; }

.cs-group { }
.cs-group-label {
  padding: 8px 10px 4px;
  font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--text-dim, #8ea0b2);
}

.cs-option {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; padding: 7px 10px; border: 0; border-radius: 8px;
  background: transparent; color: var(--text, #e1e9f1);
  cursor: pointer; font-size: 13px; text-align: left;
  transition: background .1s ease, color .1s ease;
}
.cs-option:hover, .cs-option-highlighted { background: color-mix(in srgb, var(--accent, #22a8ff) 14%, transparent); }
.cs-option-selected { color: var(--accent, #22a8ff); font-weight: 600; }
.cs-option-selected:hover, .cs-option-highlighted.cs-option-selected { background: color-mix(in srgb, var(--accent, #22a8ff) 18%, transparent); }
.cs-option-disabled { opacity: 0.45; cursor: not-allowed; }
.cs-option-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-option-check { flex-shrink: 0; color: var(--accent, #22a8ff); }

.cs-empty { padding: 12px 10px; color: var(--text-dim, #8ea0b2); font-size: 12px; text-align: center; }

/* Light mode */
:root[data-theme="light"] .cs-trigger { background: #fff; border-color: rgba(15,23,42,.14); color: #0f172a; }
:root[data-theme="light"] .cs-trigger:hover:not(:disabled) { background: #f8fafc; border-color: rgba(59,130,246,.5); }
:root[data-theme="light"] .cs-trigger[aria-expanded="true"] { border-color: rgba(59,130,246,.7); }
:root[data-theme="light"] .cs-trigger-placeholder .cs-trigger-label { color: #94a3b8; }
:root[data-theme="light"] .cs-option { color: #0f172a; }
:root[data-theme="light"] .cs-option:hover, :root[data-theme="light"] .cs-option-highlighted { background: rgba(59,130,246,.08); }
:root[data-theme="light"] .cs-option-selected { color: #2563eb; }
:root[data-theme="light"] .cs-option-check { color: #2563eb; }
:root[data-theme="light"] .cs-search { color: #0f172a; }
:root[data-theme="light"] .cs-group-label { color: #94a3b8; }
`;
