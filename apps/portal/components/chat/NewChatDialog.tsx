"use client";

import { MessageSquare, Phone, Search, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import { normalizeUsCanadaToE164 } from "@connect/shared";
import type { ChatDirectoryUser } from "./types";

export function NewChatDialog({
  open,
  users,
  onClose,
  onCreateSms,
  onCreateDm,
  onCreateGroup,
}: {
  open: boolean;
  users: ChatDirectoryUser[];
  onClose: () => void;
  onCreateSms: (phone: string) => Promise<void>;
  onCreateDm: (userId: string) => Promise<void>;
  onCreateGroup: (title: string, userIds: string[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<"sms" | "dm" | "group">("sms");
  const [phone, setPhone] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const phonePreview = phone.trim() ? normalizeUsCanadaToE164(phone.trim()) : null;

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => !u.self && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.extensionNumber || "").includes(q)));
  }, [users, search]);

  if (!open) return null;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      setPhone("");
      setSearch("");
      setSelected([]);
      setTitle("");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cc-dialog-backdrop" role="presentation" onClick={onClose}>
      <section className="cc-dialog" role="dialog" aria-modal="true" aria-label="New chat" onClick={(e) => e.stopPropagation()}>
        <header className="cc-dialog-head">
          <div>
            <h3>New chat</h3>
            <p>Start an SMS thread or internal Connect conversation.</p>
          </div>
          <button type="button" className="cc-icon-btn" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="cc-new-options">
          <button type="button" className={mode === "sms" ? "active" : ""} onClick={() => setMode("sms")}><Phone size={16} /> SMS</button>
          <button type="button" className={mode === "dm" ? "active" : ""} onClick={() => setMode("dm")}><MessageSquare size={16} /> DM</button>
          <button type="button" className={mode === "group" ? "active" : ""} onClick={() => setMode("group")}><Users size={16} /> Group</button>
        </div>

        {mode === "sms" ? (
          <div className="cc-form-stack">
            <label>
              <span>External phone number</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 123 4567" />
            </label>
            {phonePreview && !phonePreview.ok ? <p className="cc-form-error">Invalid phone number</p> : null}
            {phonePreview?.ok ? <p className="cc-form-hint">Will send through VoIP.ms to {phonePreview.e164}</p> : null}
            <button className="cc-primary-btn" disabled={busy || !phonePreview?.ok} onClick={() => run(() => onCreateSms(phone.trim()))}>Open SMS thread</button>
          </div>
        ) : (
          <div className="cc-form-stack">
            {mode === "group" ? (
              <label>
                <span>Group title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project team" />
              </label>
            ) : null}
            <label className="cc-people-search">
              <Search size={15} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tenant users or extensions" />
            </label>
            <div className="cc-people-list">
              {filteredUsers.map((u) => {
                const active = selected.includes(u.id);
                return (
                  <button
                    type="button"
                    key={u.id}
                    className={active ? "active" : ""}
                    onClick={() => mode === "dm" ? setSelected([u.id]) : setSelected((prev) => active ? prev.filter((id) => id !== u.id) : [...prev, u.id])}
                  >
                    <strong>{u.name}</strong>
                    <span>{u.email}{u.extensionNumber ? ` · Ext ${u.extensionNumber}` : ""}</span>
                  </button>
                );
              })}
            </div>
            <button
              className="cc-primary-btn"
              disabled={busy || selected.length === 0}
              onClick={() => run(() => mode === "dm" ? onCreateDm(selected[0]) : onCreateGroup(title.trim(), selected))}
            >
              {mode === "dm" ? "Open DM" : "Create group"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
