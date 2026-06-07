"use client";

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Phone, Plus, Settings2, Trash2 } from "lucide-react";
import { ConnectSelect } from "../../ConnectSelect";
import { cn } from "../cn";
import { CRMCard, crm } from "..";
import {
  phoneTypeLabel,
  type DispositionChannel,
  type WorkspacePhoneWithDisposition,
} from "./contactWorkspaceHelpers";
import { crmStatusChipClassName } from "./ContactStatusChip";

export type QuickDispositionOption = {
  id: string;
  label: string;
  isDefault?: boolean;
  color?: string;
};

export type CustomQuickDispositionDraft = {
  id: string;
  label: string;
  sortOrder: number;
  color?: string;
};

const PRIMARY_BUTTON_COUNT = 4;
const DEFAULT_CUSTOM_COLOR = "#2563EB";
const LEGACY_CUSTOM_COLOR_VALUES: Record<string, string> = {
  blue: "#2563EB",
  purple: "#9333EA",
  green: "#16A34A",
  orange: "#E67E22",
  red: "#DC2626",
  slate: "#64748B",
};

const utilityActionClass =
  "inline-flex items-center gap-0.5 border-0 bg-transparent p-0 text-[11px] font-semibold text-crm-muted transition-colors hover:text-crm-accent disabled:cursor-not-allowed disabled:opacity-50";

function compactDispositionLabel(label: string): string {
  if (label === "Left Voicemail") return "VM";
  if (label === "Call Back") return "Callback";
  if (label === "Follow Up") return "Follow-up";
  if (label === "Not Interested") return "Not int.";
  if (label === "Do Not Call") return "DNC";
  if (label === "Appointment Set") return "Appt";
  return label;
}

function normalizeCustomColor(color: string | null | undefined): string {
  const value = String(color || "").trim();
  const legacy = LEGACY_CUSTOM_COLOR_VALUES[value.toLowerCase()];
  if (legacy) return legacy;
  const match = value.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!match) return DEFAULT_CUSTOM_COLOR;
  const expanded = match.length === 3
    ? match.split("").map((char) => `${char}${char}`).join("")
    : match;
  return `#${expanded.toUpperCase()}`;
}

function customColorStyle(color: string | null | undefined): CSSProperties {
  const backgroundColor = normalizeCustomColor(color);
  return {
    backgroundColor,
    color: readableTextColor(backgroundColor),
  };
}

function readableTextColor(hexColor: string): string {
  const hex = normalizeCustomColor(hexColor).slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.64 ? "#0F172A" : "#FFFFFF";
}

export function ContactQuickDispositionCard({
  dispositionOptions,
  disposition,
  onQuickDisposition,
  saving,
  saved,
  error,
  disabled,
  activePhoneId,
  onPhoneChange,
  phones,
  contactLastDisposition,
  canManage,
  customQuickDispositions,
  onSaveCustomQuickDispositions,
  savingCustom,
  activeChannel: _activeChannel,
  onChannelChange: _onChannelChange,
  outcomeNote: _outcomeNote,
  onOutcomeNoteChange: _onOutcomeNoteChange,
  onSaveNoteDisposition: _onSaveNoteDisposition,
}: {
  dispositionOptions: QuickDispositionOption[];
  disposition: string;
  onQuickDisposition: (label: string) => void;
  outcomeNote?: string;
  onOutcomeNoteChange?: (value: string) => void;
  onSaveNoteDisposition?: () => void;
  saving: boolean;
  saved: boolean;
  error: string;
  disabled: boolean;
  activeChannel?: DispositionChannel;
  onChannelChange?: (channel: DispositionChannel) => void;
  activePhoneId: string | null;
  onPhoneChange: (phoneId: string) => void;
  phones: WorkspacePhoneWithDisposition[];
  contactLastDisposition?: string | null;
  canManage: boolean;
  customQuickDispositions: CustomQuickDispositionDraft[];
  onSaveCustomQuickDispositions: (rows: CustomQuickDispositionDraft[]) => Promise<void>;
  savingCustom: boolean;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_CUSTOM_COLOR);
  const [draftRows, setDraftRows] = useState<CustomQuickDispositionDraft[]>(customQuickDispositions);

  const activePhone = phones.find((p) => p.id === activePhoneId) ?? phones[0] ?? null;
  const lastDisposition = activePhone?.lastDisposition ?? contactLastDisposition ?? null;

  const { primaryOptions, overflowOptions } = useMemo(() => {
    return {
      primaryOptions: dispositionOptions.slice(0, PRIMARY_BUTTON_COUNT),
      overflowOptions: dispositionOptions.slice(PRIMARY_BUTTON_COUNT),
    };
  }, [dispositionOptions]);

  const customOnly = useMemo(
    () => dispositionOptions.filter((item) => !item.isDefault),
    [dispositionOptions],
  );

  function syncDraftFromProps() {
    setDraftRows(customQuickDispositions);
  }

  async function handleAddCustom() {
    const label = draftLabel.trim();
    if (!label) return;
    const next = [
      ...draftRows,
      {
        id: `custom-${Date.now()}`,
        label,
        sortOrder: draftRows.length,
        color: normalizeCustomColor(draftColor),
      },
    ];
    setDraftRows(next);
    setDraftLabel("");
    await onSaveCustomQuickDispositions(next);
  }

  async function handleRemoveCustom(id: string) {
    const next = draftRows.filter((row) => row.id !== id).map((row, index) => ({ ...row, sortOrder: index }));
    setDraftRows(next);
    await onSaveCustomQuickDispositions(next);
  }

  async function moveCustom(id: string, direction: -1 | 1) {
    const index = draftRows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= draftRows.length) return;
    const next = [...draftRows];
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row!);
    const normalized = next.map((item, sortOrder) => ({ ...item, sortOrder }));
    setDraftRows(normalized);
    await onSaveCustomQuickDispositions(normalized);
  }

  async function updateCustomColor(id: string, color: string) {
    const next = draftRows.map((row) => row.id === id ? { ...row, color: normalizeCustomColor(color) } : row);
    setDraftRows(next);
    await onSaveCustomQuickDispositions(next);
  }

  function renderDispositionButton(option: QuickDispositionOption, compact = false) {
    const isCustom = option.isDefault === false;
    const statusClassName = isCustom ? "" : crmStatusChipClassName(compactDispositionLabel(option.label));
    return (
      <button
        key={option.id}
        type="button"
        disabled={disabled || saving}
        onClick={() => onQuickDisposition(option.label)}
        style={isCustom && disposition !== option.label ? customColorStyle(option.color) : undefined}
        className={cn(
          "rounded-full border-0 px-2.5 py-1 text-[11px] font-bold leading-tight shadow-[inset_0_0_0_1px_rgba(255,255,255,0.55),0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-150",
          disposition === option.label
            ? "bg-crm-accent text-white shadow-[0_10px_18px_-14px_rgba(37,99,235,0.9)]"
            : cn(statusClassName, "hover:-translate-y-px hover:brightness-[0.98]"),
          compact && "whitespace-nowrap",
        )}
      >
        {compactDispositionLabel(option.label)}
      </button>
    );
  }

  return (
    <CRMCard padding="none" className="crm-contact-quick-disposition-card border-crm-accent/20 bg-white/95">
      <div className="space-y-1">
        {phones.length > 1 ? (
          <label className="inline-flex max-w-full items-center gap-1 text-xs font-bold tracking-tight text-crm-text">
            <Phone className="h-3 w-3 shrink-0 text-crm-muted" aria-hidden />
            <ConnectSelect
              value={activePhoneId ?? ""}
              disabled={disabled}
              onChange={(value) => onPhoneChange(value)}
              size="sm"
              className="max-w-full"
              options={phones.map((phone) => ({
                value: phone.id,
                label: `${phoneTypeLabel(phone.type)} · ${phone.numberRaw}`,
              }))}
            />
          </label>
        ) : activePhone ? (
          <p className="inline-flex max-w-full items-center gap-1 truncate text-xs font-bold tracking-tight text-crm-text">
            <Phone className="h-3 w-3 shrink-0 text-crm-muted" aria-hidden />
            <span className="truncate">
              {phoneTypeLabel(activePhone.type)} · {activePhone.numberRaw}
            </span>
          </p>
        ) : (
          <p className="text-xs text-crm-muted">No phone on file</p>
        )}

        <p className="text-[11px] leading-tight text-crm-muted">
          Last:{" "}
          <span className="font-bold text-crm-text">{lastDisposition ?? "None"}</span>
        </p>

        <div className="flex flex-wrap gap-1">
          {primaryOptions.map((option) => renderDispositionButton(option, true))}
        </div>

        {(overflowOptions.length > 0 || canManage) ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {overflowOptions.length > 0 ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => setMoreOpen((open) => !open)}
                className={utilityActionClass}
              >
                {moreOpen ? "Less" : "More"}
                {moreOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
            ) : null}
            {canManage ? (
              <button
                type="button"
                className={utilityActionClass}
                onClick={() => {
                  if (!manageOpen) syncDraftFromProps();
                  setManageOpen((open) => !open);
                }}
              >
                <Settings2 className="h-3 w-3" aria-hidden />
                {manageOpen ? "Done" : "Manage"}
              </button>
            ) : null}
          </div>
        ) : null}

        {overflowOptions.length > 0 && moreOpen ? (
          <div className="flex flex-wrap gap-1">{overflowOptions.map((option) => renderDispositionButton(option, true))}</div>
        ) : null}
      </div>

      {saved ? <p className="mt-1 text-[10px] font-semibold text-crm-success">Saved</p> : null}
      {error ? <p className="mt-1 text-[10px] font-semibold text-crm-danger">{error}</p> : null}

      {manageOpen && canManage ? (
        <div className="mt-2 rounded-xl border border-crm-border/55 bg-crm-surface/50 p-2 shadow-inner shadow-slate-950/[0.02]">
          <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Custom labels</p>
          <div className="mt-1.5 flex gap-1.5">
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="Add label…"
              className={cn(crm.input, "flex-1 bg-white py-1 text-xs shadow-none")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddCustom();
              }}
            />
            <button
              type="button"
              disabled={!draftLabel.trim() || savingCustom}
              onClick={() => void handleAddCustom()}
              className={cn(crm.btnSecondary, "rounded-full px-2 py-1")}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <label className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-crm-border/70 bg-white shadow-sm" title="Create custom label color">
              <span className="sr-only">Create custom label color</span>
              <input
                type="color"
                value={normalizeCustomColor(draftColor)}
                onChange={(event) => setDraftColor(normalizeCustomColor(event.target.value))}
                className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
              />
            </label>
            <input
              value={draftColor}
              onChange={(event) => setDraftColor(event.target.value)}
              onBlur={() => setDraftColor(normalizeCustomColor(draftColor))}
              placeholder="#2563EB"
              maxLength={7}
              className={cn(crm.input, "min-w-0 flex-1 bg-white py-1 text-xs font-semibold uppercase shadow-none")}
              aria-label="Custom label hex color"
            />
            <span
              className="shrink-0 rounded-full px-2 py-1 text-[11px] font-bold leading-tight"
              style={customColorStyle(draftColor)}
            >
              Preview
            </span>
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {draftRows.length === 0 ? (
              <p className="text-[11px] text-crm-muted">No custom labels yet.</p>
            ) : (
              draftRows.map((row) => (
                <div key={row.id} className="flex items-center gap-1.5 rounded-lg border border-crm-border/45 bg-white px-1.5 py-1">
                  <GripVertical className="h-3 w-3 text-crm-muted" />
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight"
                    style={customColorStyle(row.color)}
                  >
                    {row.label}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-1" aria-label={`${row.label} color`}>
                    <input
                      type="color"
                      value={normalizeCustomColor(row.color)}
                      className="h-5 w-5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
                      aria-label={`Create color for ${row.label}`}
                      onChange={(event) => void updateCustomColor(row.id, event.target.value)}
                    />
                    <input
                      value={normalizeCustomColor(row.color)}
                      onChange={(event) => void updateCustomColor(row.id, event.target.value)}
                      className={cn(crm.input, "min-w-0 flex-1 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase shadow-none")}
                      maxLength={7}
                      aria-label={`${row.label} hex color`}
                    />
                  </div>
                  <button type="button" className="px-0.5 text-[10px] text-crm-muted hover:text-crm-text" onClick={() => void moveCustom(row.id, -1)}>
                    ↑
                  </button>
                  <button type="button" className="px-0.5 text-[10px] text-crm-muted hover:text-crm-text" onClick={() => void moveCustom(row.id, 1)}>
                    ↓
                  </button>
                  <button type="button" className="px-0.5 text-crm-danger hover:opacity-80" onClick={() => void handleRemoveCustom(row.id)}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
          {customOnly.length > 0 ? (
            <p className="mt-1.5 text-[10px] text-crm-muted">
              {customOnly.length} custom label{customOnly.length === 1 ? "" : "s"} live for agents.
            </p>
          ) : null}
        </div>
      ) : null}
    </CRMCard>
  );
}

/** @deprecated Use ContactQuickDispositionCard in the campaign workspace right rail. */
export { ContactQuickDispositionCard as ContactWorkspaceDispositionBar };
