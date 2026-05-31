"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "../cn";
import { CRMCard, crm } from "..";
import {
  phoneTypeLabel,
  type DispositionChannel,
  type WorkspacePhoneWithDisposition,
} from "./contactWorkspaceHelpers";

export type QuickDispositionOption = {
  id: string;
  label: string;
  isDefault?: boolean;
};

export type CustomQuickDispositionDraft = {
  id: string;
  label: string;
  sortOrder: number;
};

const PRIMARY_BUTTON_COUNT = 4;

function compactDispositionLabel(label: string): string {
  if (label === "Left Voicemail") return "VM";
  if (label === "Call Back") return "Callback";
  if (label === "Follow Up") return "Follow-up";
  if (label === "Not Interested") return "Not int.";
  if (label === "Do Not Call") return "DNC";
  if (label === "Appointment Set") return "Appt";
  return label;
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

  function renderDispositionButton(option: QuickDispositionOption, compact = false) {
    return (
      <button
        key={option.id}
        type="button"
        disabled={disabled || saving}
        onClick={() => onQuickDisposition(option.label)}
        className={cn(
          "rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-tight shadow-[0_1px_0_rgba(15,23,42,0.04)] transition-all duration-150",
          disposition === option.label
            ? "border-crm-accent bg-crm-accent text-white shadow-[0_8px_18px_-14px_rgba(14,165,233,0.85)]"
            : "border-crm-border/70 bg-white text-crm-text hover:-translate-y-px hover:border-crm-accent/35 hover:bg-crm-accent/6 hover:text-crm-accent",
          compact && "whitespace-nowrap",
        )}
      >
        {compactDispositionLabel(option.label)}
      </button>
    );
  }

  return (
    <CRMCard padding="none" className="crm-contact-quick-disposition-card border-crm-accent/20 bg-white/95">
      <div className="space-y-1.5">
        {phones.length > 1 ? (
          <select
            value={activePhoneId ?? ""}
            disabled={disabled}
            onChange={(e) => onPhoneChange(e.target.value)}
            className={cn(crm.input, "border-crm-border/60 bg-white py-1 text-xs font-semibold shadow-none")}
          >
            {phones.map((phone) => (
              <option key={phone.id} value={phone.id}>
                {phoneTypeLabel(phone.type)} · {phone.numberRaw}
              </option>
            ))}
          </select>
        ) : activePhone ? (
          <p className="truncate text-xs font-bold tracking-tight text-crm-text">
            {phoneTypeLabel(activePhone.type)} · {activePhone.numberRaw}
          </p>
        ) : (
          <p className="text-xs text-crm-muted">No phone on file</p>
        )}

        <p className="text-[11px] text-crm-muted">
          Last:{" "}
          <span className="font-bold text-crm-text">{lastDisposition ?? "None"}</span>
        </p>

        <div className="flex flex-wrap gap-1">
          {primaryOptions.map((option) => renderDispositionButton(option, true))}
        </div>

        {overflowOptions.length > 0 ? (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setMoreOpen((open) => !open)}
              className="inline-flex items-center gap-0.5 rounded-full px-1 text-[11px] font-bold text-crm-accent transition-colors hover:bg-crm-accent/8"
            >
              {moreOpen ? "Less" : "More…"}
              {moreOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {moreOpen ? (
              <div className="flex flex-wrap gap-1">{overflowOptions.map((option) => renderDispositionButton(option, true))}</div>
            ) : null}
          </>
        ) : null}

        {canManage ? (
          <button
            type="button"
            className="rounded-full px-1 text-[11px] font-bold text-crm-muted transition-colors hover:bg-crm-surface-2 hover:text-crm-accent"
            onClick={() => {
              if (!manageOpen) syncDraftFromProps();
              setManageOpen((open) => !open);
            }}
          >
            {manageOpen ? "Done" : "Manage"}
          </button>
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
          <div className="mt-1.5 flex flex-col gap-1">
            {draftRows.length === 0 ? (
              <p className="text-[11px] text-crm-muted">No custom labels yet.</p>
            ) : (
              draftRows.map((row) => (
                <div key={row.id} className="flex items-center gap-1.5 rounded-lg border border-crm-border/45 bg-white px-1.5 py-1">
                  <GripVertical className="h-3 w-3 text-crm-muted" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-crm-text">{row.label}</span>
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
