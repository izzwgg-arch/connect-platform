"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, ChevronDown } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { apiGet, apiPost } from "../../../services/apiClient";

type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

type ContactOption = { id: string; displayName: string };

export function TaskQuickAdd({
  onCreated,
  defaultContactId,
  defaultContactName,
  forceOpen,
  onForceOpenConsumed,
}: {
  onCreated: () => void;
  defaultContactId?: string;
  defaultContactName?: string;
  /** External trigger to open the composer (e.g. from the header button or keyboard N) */
  forceOpen?: boolean;
  onForceOpenConsumed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM");
  const [contactSearch, setContactSearch] = useState(defaultContactName ?? "");
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<ContactOption | null>(
    defaultContactId && defaultContactName
      ? { id: defaultContactId, displayName: defaultContactName }
      : null,
  );
  const [searching, setSearching] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Respond to external open trigger
  useEffect(() => {
    if (forceOpen && !open) {
      setOpen(true);
      onForceOpenConsumed?.();
    }
  }, [forceOpen, open, onForceOpenConsumed]);

  const searchContacts = useCallback(async (q: string) => {
    if (q.length < 2) { setContactOptions([]); return; }
    setSearching(true);
    try {
      const data = await apiGet<{ rows: ContactOption[] }>(`/crm/contacts?q=${encodeURIComponent(q)}&limit=8`);
      setContactOptions(data.rows ?? []);
    } catch { setContactOptions([]); }
    finally { setSearching(false); }
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchContacts(contactSearch), 300);
    return () => clearTimeout(t);
  }, [contactSearch, searchContacts, open]);

  useEffect(() => {
    if (open) setTimeout(() => titleRef.current?.focus(), 50);
  }, [open]);

  const reset = () => {
    setTitle("");
    setDueAt("");
    setPriority("MEDIUM");
    setContactSearch(defaultContactName ?? "");
    setSelectedContact(
      defaultContactId && defaultContactName
        ? { id: defaultContactId, displayName: defaultContactName }
        : null,
    );
    setContactOptions([]);
    setError(null);
    setOpen(false);
  };

  const handleSubmit = async () => {
    if (!selectedContact || !title.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await apiPost(`/crm/contacts/${selectedContact.id}/tasks`, {
        title: title.trim(),
        dueAt: dueAt || undefined,
        priority,
      });
      reset();
      onCreated();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create task";
      setError(msg);
    } finally {
      setPosting(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={cn(crm.taskQuickAddRow, "w-full cursor-pointer text-left")}
        type="button"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-border/70 text-crm-muted">
          <Plus className="h-3.5 w-3.5" />
        </div>
        <span className="text-sm text-crm-muted">Add a task…</span>
        <span className="ml-auto text-xs text-crm-muted/50">click or press N</span>
      </button>
    );
  }

  return (
    <div className={cn(crm.card, "flex flex-col gap-3 p-4")}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-crm-text">New task</span>
        <button
          onClick={reset}
          type="button"
          className="rounded p-1 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Title — first field, gets focus */}
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title…"
        className={crm.input}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") reset();
        }}
      />

      {/* Contact search */}
      <div className="relative">
        {selectedContact ? (
          <div className="flex items-center gap-2 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2.5 text-sm text-crm-text">
            <span className="flex-1 truncate">{selectedContact.displayName}</span>
            <button
              type="button"
              onClick={() => { setSelectedContact(null); setContactSearch(""); }}
              className="shrink-0 text-crm-muted hover:text-crm-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <input
              value={contactSearch}
              onChange={(e) => { setContactSearch(e.target.value); }}
              placeholder="Search contact…"
              className={crm.input}
            />
            {searching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-crm-muted">…</span>
            )}
            {contactOptions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-crm border border-crm-border bg-crm-surface shadow-crm">
                {contactOptions.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { setSelectedContact(c); setContactSearch(c.displayName); setContactOptions([]); }}
                    className="w-full px-3 py-2 text-left text-sm text-crm-text hover:bg-crm-surface-2"
                  >
                    {c.displayName}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Due + priority row */}
      <div className="flex gap-2">
        <input
          type="date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className={cn(crm.input, "flex-1")}
          style={{ colorScheme: "dark" }}
        />
        <div className="relative">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
            className={cn(crm.select, "pr-8")}
            style={{ minWidth: "7rem" }}
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crm-muted" />
        </div>
      </div>

      {error && <p className="text-xs text-crm-danger">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={posting || !selectedContact || !title.trim()}
          className={cn(crm.btnPrimary, "flex-1")}
        >
          {posting ? "Creating…" : "Create task"}
        </button>
        <button type="button" onClick={reset} className={crm.btnSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}
