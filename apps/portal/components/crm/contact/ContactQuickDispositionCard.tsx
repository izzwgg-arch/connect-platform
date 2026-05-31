"use client";

import { useMemo, useState } from "react";
import { GripVertical, Phone, Mail, MessageSquareDot, Plus, Trash2, Voicemail } from "lucide-react";
import { cn } from "../cn";
import { CRMCard, crm } from "..";
import {
  phoneTypeLabel,
  phoneDispositionSummary,
  type DispositionChannel,
  type WorkspacePhoneWithDisposition,
} from "./contactWorkspaceHelpers";

const CHANNEL_OPTIONS: {
  id: DispositionChannel;
  label: string;
  icon: typeof Phone;
}[] = [
  { id: "CALL", label: "Call", icon: Phone },
  { id: "SMS", label: "SMS", icon: MessageSquareDot },
  { id: "EMAIL", label: "Email", icon: Mail },
  { id: "VOICEMAIL_DROP", label: "VM Drop", icon: Voicemail },
];

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

export function ContactQuickDispositionCard({
  dispositionOptions,
  disposition,
  onQuickDisposition,
  outcomeNote,
  onOutcomeNoteChange,
  onSaveNoteDisposition,
  saving,
  saved,
  error,
  disabled,
  activeChannel,
  onChannelChange,
  activePhoneId,
  onPhoneChange,
  phones,
  contactLastDisposition,
  canManage,
  customQuickDispositions,
  onSaveCustomQuickDispositions,
  savingCustom,
}: {
  dispositionOptions: QuickDispositionOption[];
  disposition: string;
  onQuickDisposition: (label: string) => void;
  outcomeNote: string;
  onOutcomeNoteChange: (value: string) => void;
  onSaveNoteDisposition: () => void;
  saving: boolean;
  saved: boolean;
  error: string;
  disabled: boolean;
  activeChannel: DispositionChannel;
  onChannelChange: (channel: DispositionChannel) => void;
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
  const [draftLabel, setDraftLabel] = useState("");
  const [draftRows, setDraftRows] = useState<CustomQuickDispositionDraft[]>(customQuickDispositions);

  const activePhone = phones.find((p) => p.id === activePhoneId) ?? phones[0] ?? null;
  const activePhoneDisposition = activePhone ? phoneDispositionSummary(activePhone) : null;

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

  return (
    <CRMCard padding="md" className="crm-contact-quick-disposition-card border-crm-accent/30 bg-crm-accent/5 shadow-crm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-crm-accent">Quick Disposition</p>
          <p className="mt-1 text-sm font-semibold text-crm-text">One-click outreach outcomes</p>
        </div>
        {canManage ? (
          <button
            type="button"
            className={cn(crm.btnGhost, "px-2 py-1 text-xs font-semibold")}
            onClick={() => {
              if (!manageOpen) syncDraftFromProps();
              setManageOpen((open) => !open);
            }}
          >
            {manageOpen ? "Done" : "Manage"}
          </button>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {CHANNEL_OPTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onChannelChange(id)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              activeChannel === id
                ? "border-crm-accent bg-crm-accent text-white"
                : "border-crm-border bg-crm-surface text-crm-muted hover:border-crm-accent/35 hover:text-crm-text",
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {phones.length > 1 ? (
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-crm-muted">Active phone</span>
            <select
              value={activePhoneId ?? ""}
              disabled={disabled}
              onChange={(e) => onPhoneChange(e.target.value)}
              className={cn(crm.input, "py-1.5 text-sm")}
            >
              {phones.map((phone) => (
                <option key={phone.id} value={phone.id}>
                  {phoneTypeLabel(phone.type)} · {phone.numberRaw}
                  {phone.lastDisposition ? ` · ${phone.lastDisposition}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : activePhone ? (
          <div className="rounded-xl border border-crm-border/70 bg-crm-surface/70 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Active phone</p>
            <p className="text-sm font-semibold text-crm-text">
              {phoneTypeLabel(activePhone.type)} · {activePhone.numberRaw}
            </p>
            {activePhoneDisposition ? (
              <p className="mt-1 text-xs font-semibold text-crm-accent">{activePhoneDisposition}</p>
            ) : null}
          </div>
        ) : null}

        {!activePhone && (
          <p className="text-xs text-crm-muted">
            Current contact disposition: {contactLastDisposition ?? "None set"}
          </p>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {dispositionOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled || saving}
            onClick={() => onQuickDisposition(option.label)}
            className={cn(
              "rounded-xl border px-2.5 py-2 text-left text-xs font-semibold transition-colors",
              disposition === option.label
                ? "border-crm-accent bg-crm-accent text-white"
                : "border-crm-border bg-crm-surface text-crm-text hover:border-crm-accent/35 hover:bg-crm-accent/10",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <input
          value={outcomeNote}
          onChange={(e) => onOutcomeNoteChange(e.target.value)}
          disabled={disabled}
          placeholder="Optional note with next save..."
          className={cn(crm.input, "py-2 text-sm")}
        />
        {disposition ? (
          <button
            type="button"
            onClick={onSaveNoteDisposition}
            disabled={!disposition || saving || disabled}
            className={cn(crm.btnSecondary, "w-full justify-center py-2 text-sm")}
          >
            {saving ? "Saving..." : `Save ${disposition}${outcomeNote.trim() ? " + note" : ""}`}
          </button>
        ) : null}
      </div>

      {saved ? <p className="mt-2 text-xs font-semibold text-crm-success">Disposition saved.</p> : null}
      {error ? <p className="mt-2 text-xs font-semibold text-crm-danger">{error}</p> : null}

      {manageOpen && canManage ? (
        <div className="mt-4 rounded-xl border border-crm-border/70 bg-crm-surface/80 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Custom quick dispositions</p>
          <div className="mt-2 flex gap-2">
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="Add custom label..."
              className={cn(crm.input, "flex-1 py-1.5 text-sm")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddCustom();
              }}
            />
            <button
              type="button"
              disabled={!draftLabel.trim() || savingCustom}
              onClick={() => void handleAddCustom()}
              className={cn(crm.btnSecondary, "px-3 py-1.5")}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {draftRows.length === 0 ? (
              <p className="text-xs text-crm-muted">No custom quick dispositions yet.</p>
            ) : (
              draftRows.map((row) => (
                <div key={row.id} className="flex items-center gap-2 rounded-lg border border-crm-border/60 bg-crm-surface px-2 py-1.5">
                  <GripVertical className="h-3.5 w-3.5 text-crm-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-crm-text">{row.label}</span>
                  <button type="button" className={cn(crm.btnGhost, "px-1 py-0.5 text-[10px]")} onClick={() => void moveCustom(row.id, -1)}>
                    Up
                  </button>
                  <button type="button" className={cn(crm.btnGhost, "px-1 py-0.5 text-[10px]")} onClick={() => void moveCustom(row.id, 1)}>
                    Down
                  </button>
                  <button type="button" className={cn(crm.btnGhost, "px-1 py-0.5 text-crm-danger")} onClick={() => void handleRemoveCustom(row.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
          {customOnly.length > 0 ? (
            <p className="mt-2 text-[11px] text-crm-muted">
              {customOnly.length} custom label{customOnly.length === 1 ? "" : "s"} available to agents.
            </p>
          ) : null}
        </div>
      ) : null}
    </CRMCard>
  );
}

/** @deprecated Use ContactQuickDispositionCard in the campaign workspace right rail. */
export { ContactQuickDispositionCard as ContactWorkspaceDispositionBar };
