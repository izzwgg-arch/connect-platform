"use client";

import { useState } from "react";
import { Calendar, ChevronDown } from "lucide-react";

export type DateRangeKey = "today" | "7d" | "30d" | "custom";

export type DateRangeValue = {
  key: DateRangeKey;
  /** ISO string. Set when key === "custom". */
  from?: string;
  /** ISO string. Set when key === "custom". */
  to?: string;
};

const PRESETS: Array<{ key: Exclude<DateRangeKey, "custom">; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "This Week" },
  { key: "30d", label: "This Month" },
];

function toLocalDateInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function fromLocalDateInput(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

type Props = {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
};

export function DateRangeFilter({ value, onChange }: Props) {
  const [customOpen, setCustomOpen] = useState(value.key === "custom");
  const [draftFrom, setDraftFrom] = useState(toLocalDateInput(value.from));
  const [draftTo, setDraftTo] = useState(toLocalDateInput(value.to));

  const handlePreset = (key: Exclude<DateRangeKey, "custom">) => {
    setCustomOpen(false);
    onChange({ key });
  };

  const handleApplyCustom = () => {
    const fromIso = fromLocalDateInput(draftFrom, false);
    const toIso = fromLocalDateInput(draftTo, true);
    if (!fromIso || !toIso) return;
    if (new Date(fromIso) >= new Date(toIso)) return;
    onChange({ key: "custom", from: fromIso, to: toIso });
  };

  return (
    <div className="dash-filter">
      <div className="dash-filter-pills" role="tablist" aria-label="Date range">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={value.key === p.key}
            className={`dash-filter-pill ${value.key === p.key ? "active" : ""}`}
            onClick={() => handlePreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={value.key === "custom"}
          className={`dash-filter-pill ${value.key === "custom" ? "active" : ""}`}
          onClick={() => setCustomOpen((o) => !o || value.key !== "custom")}
        >
          <Calendar size={14} aria-hidden />
          Custom
          <ChevronDown size={14} aria-hidden style={{ transform: customOpen ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }} />
        </button>
      </div>
      {customOpen ? (
        <div className="dash-filter-custom">
          <label className="dash-filter-custom-field">
            <span>From</span>
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
              max={draftTo || undefined}
            />
          </label>
          <label className="dash-filter-custom-field">
            <span>To</span>
            <input
              type="date"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              min={draftFrom || undefined}
            />
          </label>
          <button
            type="button"
            className="dash-filter-apply"
            onClick={handleApplyCustom}
            disabled={!draftFrom || !draftTo}
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}
