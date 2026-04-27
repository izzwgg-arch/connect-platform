"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Grid2X2,
  List,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  Search,
  Star,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { apiDelete, apiGet, apiPatch, apiPost, apiUploadContactAvatar } from "../../../services/apiClient";

type ContactType = "internal_extension" | "external" | "company";
type PhoneType = "mobile" | "office" | "home" | "other";
type EmailType = "work" | "personal" | "other";
type ViewMode = "cards" | "list";
type FilterKey = "all" | "extensions" | "external" | "companies" | "favorites";

type ContactPhone = { id?: string; type: PhoneType; numberRaw: string; numberNormalized?: string; isPrimary?: boolean };
type ContactEmail = { id?: string; type: EmailType; email: string; isPrimary?: boolean };
type ContactAddress = { street?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null };
type ContactTag = { id: string; name: string; color?: string | null };

type Contact = {
  id: string;
  tenantId: string;
  type: ContactType;
  extensionId?: string | null;
  extension?: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  avatarUrl?: string | null;
  notes?: string;
  favorite: boolean;
  source: "manual" | "extension" | "imported";
  phones: ContactPhone[];
  emails: ContactEmail[];
  addresses: ContactAddress[];
  tags: ContactTag[];
  primaryPhone?: ContactPhone | null;
  primaryEmail?: ContactEmail | null;
};

type ContactsResponse = {
  tenantId: string;
  rows: Contact[];
  tags: ContactTag[];
  stats: { total: number; internalExtensions: number; external: number; companies: number; favorites: number };
};

type ContactForm = {
  type: "external" | "company";
  firstName: string;
  lastName: string;
  displayName: string;
  company: string;
  title: string;
  phones: ContactPhone[];
  emails: ContactEmail[];
  address: ContactAddress;
  tags: string;
  notes: string;
  favorite: boolean;
};

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "extensions", label: "Extensions" },
  { key: "external", label: "External" },
  { key: "companies", label: "Companies" },
  { key: "favorites", label: "Favorites" },
];

function storedView(): ViewMode {
  if (typeof window === "undefined") return "cards";
  return localStorage.getItem("cc-contacts-view") === "list" ? "list" : "cards";
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
}

function emptyForm(): ContactForm {
  return {
    type: "external",
    firstName: "",
    lastName: "",
    displayName: "",
    company: "",
    title: "",
    phones: [{ type: "mobile", numberRaw: "", isPrimary: true }],
    emails: [{ type: "work", email: "", isPrimary: true }],
    address: { street: "", city: "", state: "", zip: "", country: "" },
    tags: "",
    notes: "",
    favorite: false,
  };
}

function formFromContact(contact: Contact): ContactForm {
  return {
    type: contact.type === "company" ? "company" : "external",
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    displayName: contact.displayName ?? "",
    company: contact.company ?? "",
    title: contact.title ?? "",
    phones: contact.phones.length ? contact.phones.map((p) => ({ type: p.type, numberRaw: p.numberRaw, isPrimary: p.isPrimary })) : [{ type: "mobile", numberRaw: "", isPrimary: true }],
    emails: contact.emails.length ? contact.emails.map((e) => ({ type: e.type, email: e.email, isPrimary: e.isPrimary })) : [{ type: "work", email: "", isPrimary: true }],
    address: contact.addresses[0] ?? { street: "", city: "", state: "", zip: "", country: "" },
    tags: contact.tags.map((tag) => tag.name).join(", "),
    notes: contact.notes ?? "",
    favorite: contact.favorite,
  };
}

function payloadFromForm(form: ContactForm) {
  return {
    type: form.type,
    firstName: form.firstName.trim() || null,
    lastName: form.lastName.trim() || null,
    displayName: form.displayName.trim() || null,
    company: form.company.trim() || null,
    title: form.title.trim() || null,
    notes: form.notes.trim() || null,
    favorite: form.favorite,
    phones: form.phones.filter((p) => p.numberRaw.trim()).map((p, index) => ({ ...p, numberRaw: p.numberRaw.trim(), isPrimary: index === 0 })),
    emails: form.emails.filter((e) => e.email.trim()).map((e, index) => ({ ...e, email: e.email.trim(), isPrimary: index === 0 })),
    addresses: Object.values(form.address).some((v) => String(v ?? "").trim()) ? [form.address] : [],
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
  };
}

function contactSubtitle(contact: Contact): string {
  if (contact.type === "internal_extension") return contact.title || "Internal extension";
  return [contact.title, contact.company].filter(Boolean).join(" at ") || (contact.type === "company" ? "Company contact" : "External contact");
}

function presenceFor(contact: Contact, telephony: ReturnType<typeof useTelephony>): "available" | "ringing" | "on_call" | "offline" {
  if (contact.type !== "internal_extension" || !contact.extension) return "offline";
  const ext = contact.extension;
  const call = telephony.activeCalls.find((c) => (c.extensions ?? []).includes(ext));
  if (call?.state === "ringing" || call?.state === "dialing") return "ringing";
  if (call?.state === "up" || call?.state === "held") return "on_call";
  const live = telephony.extensionList.find((entry) => entry.extension === ext && (!entry.tenantId || entry.tenantId === contact.tenantId));
  const status = String(live?.status ?? "").toLowerCase();
  if (["idle", "not_inuse", "registered", "0"].includes(status)) return "available";
  if (["inuse", "busy", "onhold", "1", "3"].includes(status)) return "on_call";
  if (["ringing", "2"].includes(status)) return "ringing";
  return "offline";
}

function Avatar({ contact, size = 48 }: { contact: Contact; size?: number }) {
  return (
    <div className="cx-avatar" style={{ width: size, height: size }}>
      {contact.avatarUrl ? <img src={contact.avatarUrl} alt="" /> : <span>{initials(contact.displayName)}</span>}
    </div>
  );
}

function TypePill({ contact }: { contact: Contact }) {
  const label = contact.type === "internal_extension" ? "Extension" : contact.type === "company" ? "Company" : "External";
  return <span className={`cx-pill cx-pill--${contact.type}`}>{label}</span>;
}

function StatusPill({ status }: { status: ReturnType<typeof presenceFor> }) {
  const label = status === "on_call" ? "On call" : status[0].toUpperCase() + status.slice(1);
  return <span className={`cx-status cx-status--${status}`}><i />{label}</span>;
}

function ContactActions({ contact, onCall, onMessage }: { contact: Contact; onCall: (c: Contact) => void; onMessage: (c: Contact) => void }) {
  const email = contact.primaryEmail?.email;
  return (
    <div className="cx-actions">
      <button type="button" title="Call" onClick={(e) => { e.stopPropagation(); onCall(contact); }}><Phone size={15} /></button>
      <button type="button" title="Message" onClick={(e) => { e.stopPropagation(); onMessage(contact); }}><MessageSquare size={15} /></button>
      <a title="Email" onClick={(e) => e.stopPropagation()} href={email ? `mailto:${email}` : undefined} aria-disabled={!email}><Mail size={15} /></a>
    </div>
  );
}

function ContactCard({ contact, status, onOpen, onCall, onMessage }: { contact: Contact; status: ReturnType<typeof presenceFor>; onOpen: () => void; onCall: (c: Contact) => void; onMessage: (c: Contact) => void }) {
  return (
    <button type="button" className="cx-card" onClick={onOpen}>
      <div className="cx-card-top">
        <Avatar contact={contact} />
        <div className="cx-card-badges">
          {contact.favorite ? <Star size={15} className="cx-star" fill="currentColor" /> : null}
          <TypePill contact={contact} />
        </div>
      </div>
      <div className="cx-card-body">
        <strong>{contact.displayName}</strong>
        <span>{contactSubtitle(contact)}</span>
      </div>
      <div className="cx-card-meta">
        <span>{contact.type === "internal_extension" ? `Ext. ${contact.extension}` : contact.primaryPhone?.numberRaw || "No phone"}</span>
        <span>{contact.primaryEmail?.email || "No email"}</span>
      </div>
      <div className="cx-tag-row">
        {contact.type === "internal_extension" ? <StatusPill status={status} /> : null}
        {contact.tags.slice(0, 3).map((tag) => <span key={tag.name} className="cx-tag">{tag.name}</span>)}
      </div>
      <ContactActions contact={contact} onCall={onCall} onMessage={onMessage} />
    </button>
  );
}

function ContactList({ contacts, statuses, onOpen, onCall, onMessage }: { contacts: Contact[]; statuses: Map<string, ReturnType<typeof presenceFor>>; onOpen: (c: Contact) => void; onCall: (c: Contact) => void; onMessage: (c: Contact) => void }) {
  return (
    <div className="cx-list">
      <div className="cx-list-head">
        <span>Name</span><span>Type</span><span>Phone / Extension</span><span>Email</span><span>Company</span><span>Tags</span><span>Status</span><span />
      </div>
      {contacts.map((contact) => (
        <button key={contact.id} type="button" className="cx-list-row" onClick={() => onOpen(contact)}>
          <span className="cx-list-name"><Avatar contact={contact} size={38} /><strong>{contact.displayName}</strong></span>
          <TypePill contact={contact} />
          <span>{contact.type === "internal_extension" ? `Ext. ${contact.extension}` : contact.primaryPhone?.numberRaw || "—"}</span>
          <span>{contact.primaryEmail?.email || "—"}</span>
          <span>{contact.company || "—"}</span>
          <span className="cx-tag-row">{contact.tags.slice(0, 2).map((tag) => <em key={tag.name} className="cx-tag">{tag.name}</em>)}</span>
          <span>{contact.type === "internal_extension" ? <StatusPill status={statuses.get(contact.id) ?? "offline"} /> : "—"}</span>
          <ContactActions contact={contact} onCall={onCall} onMessage={onMessage} />
        </button>
      ))}
    </div>
  );
}

function ContactPanel({ contact, status, onClose, onEdit, onArchive, onCall, onMessage }: { contact: Contact; status: ReturnType<typeof presenceFor>; onClose: () => void; onEdit: () => void; onArchive: () => void; onCall: (c: Contact) => void; onMessage: (c: Contact) => void }) {
  return (
    <aside className="cx-panel">
      <button type="button" className="cx-panel-close" onClick={onClose}><X size={18} /></button>
      <div className="cx-panel-hero">
        <Avatar contact={contact} size={78} />
        <h2>{contact.displayName}</h2>
        <p>{contactSubtitle(contact)}</p>
        <div className="cx-tag-row cx-center">
          <TypePill contact={contact} />
          {contact.type === "internal_extension" ? <StatusPill status={status} /> : null}
          {contact.favorite ? <span className="cx-tag">Favorite</span> : null}
        </div>
      </div>
      <div className="cx-panel-actions">
        <button type="button" onClick={() => onCall(contact)}><Phone size={16} />Call</button>
        <button type="button" onClick={() => onMessage(contact)}><MessageSquare size={16} />Message</button>
        {contact.primaryEmail?.email ? <a href={`mailto:${contact.primaryEmail.email}`}><Mail size={16} />Email</a> : null}
      </div>
      <section className="cx-detail-section">
        <h3>Phone Numbers</h3>
        {contact.phones.length ? contact.phones.map((phone) => <p key={`${phone.type}-${phone.numberRaw}`}><span>{phone.type}</span><strong>{phone.numberRaw}</strong></p>) : <p className="cx-muted">No phone numbers</p>}
      </section>
      <section className="cx-detail-section">
        <h3>Email Addresses</h3>
        {contact.emails.length ? contact.emails.map((email) => <p key={`${email.type}-${email.email}`}><span>{email.type}</span><strong>{email.email}</strong></p>) : <p className="cx-muted">No emails</p>}
      </section>
      <section className="cx-detail-section">
        <h3>Address</h3>
        {contact.addresses[0] ? <p><span>Primary</span><strong>{[contact.addresses[0].street, contact.addresses[0].city, contact.addresses[0].state, contact.addresses[0].zip, contact.addresses[0].country].filter(Boolean).join(", ") || "—"}</strong></p> : <p className="cx-muted">No address</p>}
      </section>
      <section className="cx-detail-section">
        <h3>Tags</h3>
        <div className="cx-tag-row">{contact.tags.length ? contact.tags.map((tag) => <span key={tag.name} className="cx-tag">{tag.name}</span>) : <span className="cx-muted">No tags</span>}</div>
      </section>
      <section className="cx-detail-section">
        <h3>Notes</h3>
        <p className="cx-notes">{contact.notes || "No notes yet."}</p>
      </section>
      <section className="cx-detail-section">
        <h3>Recent Activity</h3>
        <p className="cx-muted">Recent calls and messages will appear here as activity data is connected.</p>
      </section>
      <div className="cx-panel-footer">
        {contact.type !== "internal_extension" ? <button type="button" onClick={onEdit}>Edit</button> : null}
        {contact.type !== "internal_extension" ? <button type="button" className="danger" onClick={onArchive}><Archive size={15} />Archive</button> : null}
      </div>
    </aside>
  );
}

function ContactModal({ contact, onClose, onSaved }: { contact?: Contact | null; onClose: () => void; onSaved: (contact?: Contact) => void }) {
  const [form, setForm] = useState<ContactForm>(() => contact && contact.type !== "internal_extension" ? formFromContact(contact) : emptyForm());
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function update<K extends keyof ContactForm>(key: K, value: ContactForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const payload = payloadFromForm(form);
    if (!payload.displayName && !payload.firstName && !payload.lastName && !payload.company && payload.phones.length === 0 && payload.emails.length === 0) {
      setError("Add at least a name, company, phone, or email.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = contact
        ? await apiPatch<{ contact: Contact }>(`/contacts/${encodeURIComponent(contact.id)}`, payload)
        : await apiPost<{ contact: Contact }>("/contacts", payload);
      let saved = response.contact;
      if (avatarFile && saved.type !== "internal_extension") {
        const upload = await apiUploadContactAvatar(saved.id, avatarFile);
        saved = { ...saved, avatarUrl: upload.avatarUrl };
      }
      onSaved(saved);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Could not save contact.");
      setSaving(false);
    }
  }

  return (
    <div className="cx-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cx-modal">
        <div className="cx-modal-head">
          <div>
            <h2>{contact ? "Edit contact" : "Add contact"}</h2>
            <p>Full tenant-scoped profile for calling, messaging, and CRM context.</p>
          </div>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="cx-form-grid">
          <label className="cx-upload">
            <Upload size={17} />
            <span>{avatarFile ? avatarFile.name : "Upload profile picture"}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setAvatarFile(event.target.files?.[0] ?? null)} />
          </label>
          <label><span>Type</span><select value={form.type} onChange={(e) => update("type", e.target.value as ContactForm["type"])}><option value="external">External Contact</option><option value="company">Company Contact</option></select></label>
          <label><span>First name</span><input value={form.firstName} onChange={(e) => update("firstName", e.target.value)} /></label>
          <label><span>Last name</span><input value={form.lastName} onChange={(e) => update("lastName", e.target.value)} /></label>
          <label><span>Display name</span><input value={form.displayName} onChange={(e) => update("displayName", e.target.value)} /></label>
          <label><span>Company</span><input value={form.company} onChange={(e) => update("company", e.target.value)} /></label>
          <label><span>Title / role</span><input value={form.title} onChange={(e) => update("title", e.target.value)} /></label>
          <label className="cx-check"><input type="checkbox" checked={form.favorite} onChange={(e) => update("favorite", e.target.checked)} /> Favorite</label>
        </div>
        <DynamicPhones phones={form.phones} onChange={(phones) => update("phones", phones)} />
        <DynamicEmails emails={form.emails} onChange={(emails) => update("emails", emails)} />
        <div className="cx-form-grid">
          <label className="wide"><span>Street</span><input value={form.address.street ?? ""} onChange={(e) => update("address", { ...form.address, street: e.target.value })} /></label>
          <label><span>City</span><input value={form.address.city ?? ""} onChange={(e) => update("address", { ...form.address, city: e.target.value })} /></label>
          <label><span>State</span><input value={form.address.state ?? ""} onChange={(e) => update("address", { ...form.address, state: e.target.value })} /></label>
          <label><span>ZIP</span><input value={form.address.zip ?? ""} onChange={(e) => update("address", { ...form.address, zip: e.target.value })} /></label>
          <label><span>Country</span><input value={form.address.country ?? ""} onChange={(e) => update("address", { ...form.address, country: e.target.value })} /></label>
          <label className="wide"><span>Tags</span><input placeholder="VIP, Vendor, Billing" value={form.tags} onChange={(e) => update("tags", e.target.value)} /></label>
          <label className="wide"><span>Notes</span><textarea value={form.notes} onChange={(e) => update("notes", e.target.value)} /></label>
        </div>
        {error ? <div className="cx-error">{error}</div> : null}
        <div className="cx-modal-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save contact"}</button>
        </div>
      </div>
    </div>
  );
}

function DynamicPhones({ phones, onChange }: { phones: ContactPhone[]; onChange: (phones: ContactPhone[]) => void }) {
  return (
    <section className="cx-dynamic">
      <div><h3>Phone numbers</h3><button type="button" onClick={() => onChange([...phones, { type: "mobile", numberRaw: "" }])}><Plus size={14} />Add phone</button></div>
      {phones.map((phone, index) => (
        <div className="cx-dynamic-row" key={index}>
          <select value={phone.type} onChange={(e) => onChange(phones.map((p, i) => i === index ? { ...p, type: e.target.value as PhoneType } : p))}><option value="mobile">Mobile</option><option value="office">Office</option><option value="home">Home</option><option value="other">Other</option></select>
          <input type="tel" value={phone.numberRaw} onChange={(e) => onChange(phones.map((p, i) => i === index ? { ...p, numberRaw: e.target.value } : p))} placeholder="(845) 555-1234" />
          <button type="button" onClick={() => onChange(phones.filter((_, i) => i !== index))}><X size={14} /></button>
        </div>
      ))}
    </section>
  );
}

function DynamicEmails({ emails, onChange }: { emails: ContactEmail[]; onChange: (emails: ContactEmail[]) => void }) {
  return (
    <section className="cx-dynamic">
      <div><h3>Email addresses</h3><button type="button" onClick={() => onChange([...emails, { type: "work", email: "" }])}><Plus size={14} />Add email</button></div>
      {emails.map((email, index) => (
        <div className="cx-dynamic-row" key={index}>
          <select value={email.type} onChange={(e) => onChange(emails.map((item, i) => i === index ? { ...item, type: e.target.value as EmailType } : item))}><option value="work">Work</option><option value="personal">Personal</option><option value="other">Other</option></select>
          <input type="email" value={email.email} onChange={(e) => onChange(emails.map((item, i) => i === index ? { ...item, email: e.target.value } : item))} placeholder="name@company.com" />
          <button type="button" onClick={() => onChange(emails.filter((_, i) => i !== index))}><X size={14} /></button>
        </div>
      ))}
    </section>
  );
}

export default function ContactsPage() {
  const { adminScope, tenantId, tenant } = useAppContext();
  const telephony = useTelephony();
  const phone = useSipPhone();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [view, setView] = useState<ViewMode>(storedView);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editing, setEditing] = useState<Contact | null | undefined>(undefined);

  const effectiveTenantId = tenantId;
  const contactsPath = useMemo(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (filter !== "all") params.set("type", filter);
    if (adminScope === "GLOBAL" && effectiveTenantId) params.set("tenantId", effectiveTenantId);
    const qs = params.toString();
    return `/contacts${qs ? `?${qs}` : ""}`;
  }, [adminScope, effectiveTenantId, filter, query]);

  const state = useAsyncResource<ContactsResponse>(
    () => effectiveTenantId ? apiGet<ContactsResponse>(contactsPath) : Promise.resolve({ tenantId: "", rows: [], tags: [], stats: { total: 0, internalExtensions: 0, external: 0, companies: 0, favorites: 0 } }),
    [contactsPath, effectiveTenantId, reloadKey],
  );
  const data = state.status === "success" ? state.data : null;
  const contacts = data?.rows ?? [];
  const statuses = useMemo(() => new Map(contacts.map((contact) => [contact.id, presenceFor(contact, telephony)])), [contacts, telephony]);

  useEffect(() => {
    localStorage.setItem("cc-contacts-view", view);
  }, [view]);

  useEffect(() => {
    setSelected(null);
  }, [effectiveTenantId]);

  const callContact = useCallback((contact: Contact) => {
    const target = contact.type === "internal_extension" ? contact.extension : contact.primaryPhone?.numberRaw;
    if (!target) return;
    phone.setDialpadInput(target);
    phone.dial(target);
  }, [phone]);

  const messageContact = useCallback((contact: Contact) => {
    if (contact.type === "internal_extension" && contact.extension) {
      router.push(`/chat?ext=${encodeURIComponent(contact.extension)}`);
      return;
    }
    const target = contact.primaryPhone?.numberRaw;
    if (target) router.push(`/sms?phone=${encodeURIComponent(target)}`);
  }, [router]);

  async function archiveContact(contact: Contact) {
    if (contact.type === "internal_extension") return;
    await apiDelete(`/contacts/${encodeURIComponent(contact.id)}`);
    setSelected(null);
    setReloadKey((key) => key + 1);
  }

  return (
    <PermissionGate permission="can_view_contacts" fallback={<div className="state-box">You do not have contacts access.</div>}>
      <div className="cx-shell">
        <style jsx global>{CONTACTS_CSS}</style>
        <header className="cx-hero">
          <div>
            <span className="cx-kicker"><UserRound size={15} /> Tenant contacts</span>
            <h1>Contacts</h1>
            <p>People, extensions, and customers for {tenant?.name ?? "this tenant"}.</p>
          </div>
          <div className="cx-hero-actions">
            <button type="button" className="cx-secondary"><Upload size={16} />Import CSV</button>
            <button type="button" className="cx-primary" onClick={() => setEditing(null)}><Plus size={17} />Add Contact</button>
          </div>
        </header>

        {!effectiveTenantId ? (
          <EmptyState title="Select a tenant" message="Contacts are tenant-scoped. Choose a tenant to view people and extensions." />
        ) : state.status === "loading" ? (
          <LoadingSkeleton rows={8} />
        ) : state.status === "error" ? (
          <ErrorState message={state.error} />
        ) : (
          <>
            <section className="cx-stats">
              <div><span>Total contacts</span><strong>{data?.stats.total ?? 0}</strong></div>
              <div><span>Internal extensions</span><strong>{data?.stats.internalExtensions ?? 0}</strong></div>
              <div><span>External contacts</span><strong>{data?.stats.external ?? 0}</strong></div>
              <div><span>Favorites</span><strong>{data?.stats.favorites ?? 0}</strong></div>
            </section>

            <section className="cx-toolbar">
              <label className="cx-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone, email, extension, company..." /></label>
              <div className="cx-filters">{FILTERS.map((item) => <button key={item.key} type="button" data-active={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}</div>
              <div className="cx-view-toggle">
                <button type="button" data-active={view === "cards"} onClick={() => setView("cards")}><Grid2X2 size={15} /></button>
                <button type="button" data-active={view === "list"} onClick={() => setView("list")}><List size={15} /></button>
              </div>
            </section>

            {contacts.length === 0 ? (
              <EmptyState title="No contacts found" message="No tenant contacts match this view." />
            ) : view === "cards" ? (
              <section className="cx-grid">
                {contacts.map((contact) => <ContactCard key={contact.id} contact={contact} status={statuses.get(contact.id) ?? "offline"} onOpen={() => setSelected(contact)} onCall={callContact} onMessage={messageContact} />)}
              </section>
            ) : (
              <ContactList contacts={contacts} statuses={statuses} onOpen={setSelected} onCall={callContact} onMessage={messageContact} />
            )}
          </>
        )}

        {selected ? (
          <ContactPanel
            contact={selected}
            status={statuses.get(selected.id) ?? "offline"}
            onClose={() => setSelected(null)}
            onEdit={() => setEditing(selected)}
            onArchive={() => archiveContact(selected)}
            onCall={callContact}
            onMessage={messageContact}
          />
        ) : null}

        {editing !== undefined ? (
          <ContactModal
            contact={editing}
            onClose={() => setEditing(undefined)}
            onSaved={(contact) => {
              setReloadKey((key) => key + 1);
              if (contact) setSelected(contact);
            }}
          />
        ) : null}
      </div>
    </PermissionGate>
  );
}

const CONTACTS_CSS = `
.cx-shell { display: flex; flex-direction: column; gap: 18px; padding-bottom: 32px; }
.cx-hero { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 22px; border: 1px solid var(--border); border-radius: 24px; background: radial-gradient(circle at top left, rgba(99,102,241,.18), transparent 34%), var(--panel); box-shadow: 0 20px 50px rgba(0,0,0,.18); }
.cx-kicker { display: inline-flex; align-items: center; gap: 7px; color: var(--accent); font-weight: 850; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
.cx-hero h1 { margin: 8px 0 4px; font-size: clamp(32px, 4vw, 48px); line-height: .95; }
.cx-hero p { margin: 0; color: var(--text-dim); font-size: 15px; }
.cx-hero-actions, .cx-actions, .cx-panel-actions, .cx-modal-actions { display: flex; gap: 8px; align-items: center; }
.cx-primary, .cx-secondary, .cx-panel-actions button, .cx-panel-actions a, .cx-modal-actions button, .cx-dynamic button { border: 0; border-radius: 999px; min-height: 38px; padding: 0 14px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer; font-weight: 850; }
.cx-primary, .cx-modal-actions button:last-child { color: white; background: linear-gradient(135deg, #6366f1, #8b5cf6); box-shadow: 0 14px 30px rgba(99,102,241,.28); }
.cx-secondary, .cx-modal-actions .ghost { color: var(--text); background: var(--panel-2); border: 1px solid var(--border); }
.cx-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.cx-stats div { padding: 16px; border-radius: 18px; border: 1px solid var(--border); background: var(--panel); }
.cx-stats span { display: block; color: var(--text-dim); font-size: 12px; font-weight: 800; }
.cx-stats strong { display: block; margin-top: 6px; font-size: 28px; }
.cx-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px; border: 1px solid var(--border); border-radius: 18px; background: var(--panel); }
.cx-search { flex: 1; min-width: min(340px, 100%); display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 13px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel-2); color: var(--text-dim); }
.cx-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); min-width: 0; }
.cx-filters, .cx-view-toggle { display: flex; align-items: center; gap: 6px; }
.cx-filters button, .cx-view-toggle button { border: 1px solid var(--border); color: var(--text-dim); background: transparent; border-radius: 999px; min-height: 34px; padding: 0 11px; cursor: pointer; font-weight: 850; }
.cx-filters button[data-active="true"], .cx-view-toggle button[data-active="true"] { color: white; border-color: transparent; background: #6366f1; }
.cx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.cx-card { position: relative; text-align: left; border: 1px solid var(--border); border-radius: 22px; padding: 16px; background: linear-gradient(180deg, var(--panel), var(--panel-2)); color: var(--text); cursor: pointer; box-shadow: 0 16px 34px rgba(0,0,0,.12); transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
.cx-card:hover { transform: translateY(-3px); border-color: rgba(99,102,241,.45); box-shadow: 0 22px 48px rgba(0,0,0,.18); }
.cx-card-top { display: flex; justify-content: space-between; gap: 10px; }
.cx-card-badges { display: flex; align-items: flex-start; gap: 7px; }
.cx-avatar { border-radius: 18px; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; color: white; font-weight: 950; background: linear-gradient(135deg, #0ea5e9, #6366f1 55%, #a855f7); box-shadow: inset 0 1px 0 rgba(255,255,255,.22); flex: 0 0 auto; }
.cx-avatar img { width: 100%; height: 100%; object-fit: cover; }
.cx-card-body { display: grid; gap: 4px; margin-top: 14px; }
.cx-card-body strong { font-size: 17px; }
.cx-card-body span, .cx-card-meta span, .cx-muted { color: var(--text-dim); font-size: 12px; }
.cx-card-meta { display: grid; gap: 5px; margin-top: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cx-pill, .cx-status, .cx-tag { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 5px 8px; font-size: 11px; font-weight: 850; font-style: normal; white-space: nowrap; }
.cx-pill { background: rgba(99,102,241,.12); color: #818cf8; }
.cx-pill--internal_extension { color: #38bdf8; background: rgba(56,189,248,.12); }
.cx-pill--company { color: #f59e0b; background: rgba(245,158,11,.13); }
.cx-tag { color: var(--text-dim); border: 1px solid var(--border); background: var(--panel-2); }
.cx-tag-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.cx-status i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.cx-status--available { color: #22c55e; background: rgba(34,197,94,.12); }
.cx-status--ringing { color: #f59e0b; background: rgba(245,158,11,.13); }
.cx-status--on_call { color: #ef4444; background: rgba(239,68,68,.13); }
.cx-status--offline { color: var(--text-dim); background: var(--panel-2); }
.cx-actions { margin-top: 14px; }
.cx-actions button, .cx-actions a { width: 34px; height: 34px; border-radius: 12px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text-dim); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.cx-actions a[aria-disabled="true"] { opacity: .4; pointer-events: none; }
.cx-star { color: #facc15; }
.cx-list { display: grid; gap: 8px; }
.cx-list-head, .cx-list-row { display: grid; grid-template-columns: 1.7fr .75fr 1fr 1.25fr 1fr 1fr .9fr auto; gap: 10px; align-items: center; }
.cx-list-head { padding: 0 14px; color: var(--text-dim); font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
.cx-list-row { width: 100%; text-align: left; border: 1px solid var(--border); border-radius: 16px; padding: 10px 12px; background: var(--panel); color: var(--text); cursor: pointer; }
.cx-list-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cx-list-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-panel { position: fixed; right: 0; top: 0; bottom: 0; z-index: 180; width: min(440px, 100vw); overflow: auto; padding: 22px; border-left: 1px solid var(--border); background: color-mix(in srgb, var(--panel) 94%, transparent); backdrop-filter: blur(20px); box-shadow: -20px 0 60px rgba(0,0,0,.32); }
.cx-panel-close { position: absolute; top: 14px; right: 14px; width: 34px; height: 34px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); color: var(--text); cursor: pointer; }
.cx-panel-hero { text-align: center; padding: 28px 10px 18px; }
.cx-panel-hero h2 { margin: 12px 0 4px; }
.cx-panel-hero p { margin: 0; color: var(--text-dim); }
.cx-center { justify-content: center; }
.cx-panel-actions { justify-content: center; padding-bottom: 14px; }
.cx-panel-actions button, .cx-panel-actions a { color: var(--text); background: var(--panel-2); border: 1px solid var(--border); text-decoration: none; }
.cx-detail-section { border-top: 1px solid var(--border); padding: 15px 0; }
.cx-detail-section h3 { margin: 0 0 10px; font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .08em; }
.cx-detail-section p { display: flex; justify-content: space-between; gap: 16px; margin: 8px 0; }
.cx-detail-section p span { color: var(--text-dim); text-transform: capitalize; }
.cx-detail-section p strong { text-align: right; font-weight: 750; }
.cx-notes { display: block !important; color: var(--text-dim); line-height: 1.55; }
.cx-panel-footer { display: flex; gap: 8px; padding-top: 10px; }
.cx-panel-footer button { flex: 1; min-height: 38px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); color: var(--text); cursor: pointer; font-weight: 850; }
.cx-panel-footer .danger { color: #ef4444; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.cx-modal-backdrop { position: fixed; inset: 0; z-index: 220; display: flex; justify-content: center; align-items: center; padding: 18px; background: rgba(0,0,0,.58); }
.cx-modal { width: min(860px, 100%); max-height: min(92vh, 980px); overflow: auto; border: 1px solid var(--border); border-radius: 24px; background: var(--panel); box-shadow: 0 30px 90px rgba(0,0,0,.38); padding: 18px; }
.cx-modal-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.cx-modal-head h2 { margin: 0 0 4px; }
.cx-modal-head p { margin: 0; color: var(--text-dim); }
.cx-modal-head button, .cx-dynamic-row button { border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); color: var(--text); cursor: pointer; }
.cx-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.cx-form-grid label, .cx-dynamic { display: grid; gap: 6px; }
.cx-form-grid label span, .cx-dynamic h3 { color: var(--text-dim); font-size: 12px; font-weight: 850; margin: 0; }
.cx-form-grid input, .cx-form-grid select, .cx-form-grid textarea, .cx-dynamic input, .cx-dynamic select { width: 100%; min-height: 40px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); color: var(--text); padding: 0 11px; outline: none; }
.cx-form-grid textarea { min-height: 86px; padding-top: 10px; resize: vertical; }
.cx-form-grid .wide, .cx-upload { grid-column: 1 / -1; }
.cx-upload { min-height: 54px; border: 1px dashed var(--border); border-radius: 16px; display: flex !important; align-items: center; justify-content: center; gap: 8px; cursor: pointer; color: var(--text-dim); }
.cx-upload input { display: none; }
.cx-check { display: flex !important; grid-template-columns: auto 1fr; align-items: center; gap: 8px; color: var(--text-dim); }
.cx-check input { width: auto; min-height: auto; }
.cx-dynamic { margin: 14px 0; }
.cx-dynamic > div:first-child { display: flex; justify-content: space-between; align-items: center; }
.cx-dynamic > div:first-child button { min-height: 30px; padding: 0 10px; color: var(--text); background: var(--panel-2); border: 1px solid var(--border); }
.cx-dynamic-row { display: grid; grid-template-columns: 130px 1fr 40px; gap: 8px; margin-top: 8px; }
.cx-error { margin-top: 12px; padding: 10px 12px; border-radius: 12px; color: #ef4444; background: rgba(239,68,68,.12); font-weight: 800; }
.cx-modal-actions { justify-content: flex-end; margin-top: 16px; }
@media (max-width: 980px) {
  .cx-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cx-list-head { display: none; }
  .cx-list-row { grid-template-columns: 1fr; }
  .cx-hero { flex-direction: column; }
}
@media (max-width: 640px) {
  .cx-stats, .cx-form-grid { grid-template-columns: 1fr; }
  .cx-dynamic-row { grid-template-columns: 1fr; }
  .cx-hero-actions { width: 100%; flex-direction: column; align-items: stretch; }
}
`;
