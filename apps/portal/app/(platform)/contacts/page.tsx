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
import { ConnectSelect } from "../../../components/ConnectSelect";
import {
  CRMActionBar,
  CRMPageHeader,
  CRMPageShell,
  CRMWorkspaceBody,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceMain,
  CRMWorkspaceRightRail,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceShell,
  CRMWorkspaceToolbar,
  cn,
  crm,
} from "../../../components/crm";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { apiDelete, apiGet, apiPatch, apiPost, apiUploadContactAvatar } from "../../../services/apiClient";
import { liveExtensionForTenant } from "../../../services/liveCallState";

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
  // Only consider live calls belonging to this contact's tenant, otherwise
  // two tenants that share an extension number (e.g. both have "106") would
  // leak presence across tenants.
  const call = telephony.activeCalls.find((c) =>
    (c.extensions ?? []).includes(ext) &&
    (!contact.tenantId || !c.tenantId || c.tenantId === contact.tenantId),
  );
  if (call?.state === "ringing" || call?.state === "dialing") return "ringing";
  if (call?.state === "up" || call?.state === "held") return "on_call";
  const live = liveExtensionForTenant(telephony.extensionList, ext, contact.tenantId);
  const status = String(live?.status ?? "").toLowerCase();
  if (["idle", "not_inuse", "registered", "0"].includes(status)) return "available";
  // AMI "busy" without a matching live call is unreliable when multiple
  // tenants share a number; treat it as available to keep BLF/Dashboard
  // consistent.
  if (["inuse", "busy", "onhold", "1", "2", "3", "ringing"].includes(status)) return "available";
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

function ContactActions({ contact, onCall, onMessage, onEmail }: { contact: Contact; onCall: (c: Contact) => void; onMessage: (c: Contact) => void; onEmail: (c: Contact) => void }) {
  const email = contact.primaryEmail?.email;
  return (
    <div className="cx-actions">
      <button type="button" title="Call" onClick={(e) => { e.stopPropagation(); onCall(contact); }}><Phone size={15} /></button>
      <button type="button" title="Message" onClick={(e) => { e.stopPropagation(); onMessage(contact); }}><MessageSquare size={15} /></button>
      <button type="button" title="Email" onClick={(e) => { e.stopPropagation(); onEmail(contact); }} disabled={!email}><Mail size={15} /></button>
    </div>
  );
}

function ContactCard({ contact, status, onOpen, onCall, onMessage, onEmail }: { contact: Contact; status: ReturnType<typeof presenceFor>; onOpen: () => void; onCall: (c: Contact) => void; onMessage: (c: Contact) => void; onEmail: (c: Contact) => void }) {
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
      <ContactActions contact={contact} onCall={onCall} onMessage={onMessage} onEmail={onEmail} />
    </button>
  );
}

function ContactList({ contacts, statuses, onOpen, onCall, onMessage, onEmail }: { contacts: Contact[]; statuses: Map<string, ReturnType<typeof presenceFor>>; onOpen: (c: Contact) => void; onCall: (c: Contact) => void; onMessage: (c: Contact) => void; onEmail: (c: Contact) => void }) {
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
          <ContactActions contact={contact} onCall={onCall} onMessage={onMessage} onEmail={onEmail} />
        </button>
      ))}
    </div>
  );
}

function ContactPanel({ contact, canManage, status, onEdit, onArchive, onCall, onMessage, onEmail }: { contact: Contact; canManage: boolean; status: ReturnType<typeof presenceFor>; onEdit: () => void; onArchive: () => void; onCall: (c: Contact) => void; onMessage: (c: Contact) => void; onEmail: (c: Contact) => void }) {
  return (
    <aside className="cx-panel">
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
        {contact.primaryEmail?.email ? <button type="button" onClick={() => onEmail(contact)}><Mail size={16} />Email</button> : null}
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
        {canManage && contact.type !== "internal_extension" ? <button type="button" onClick={onEdit}>Edit</button> : null}
        {canManage && contact.type !== "internal_extension" ? <button type="button" className="danger" onClick={onArchive}><Archive size={15} />Archive</button> : null}
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
          <label><span>Type</span><ConnectSelect size="sm" value={form.type} onChange={(v) => update("type", v as ContactForm["type"])} options={[{ value: "external", label: "External Contact" }, { value: "company", label: "Company Contact" }]} /></label>
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
          <ConnectSelect size="sm" value={phone.type} onChange={(v) => onChange(phones.map((p, i) => i === index ? { ...p, type: v as PhoneType } : p))} options={[{ value: "mobile", label: "Mobile" }, { value: "office", label: "Office" }, { value: "home", label: "Home" }, { value: "other", label: "Other" }]} />
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
          <ConnectSelect size="sm" value={email.type} onChange={(v) => onChange(emails.map((item, i) => i === index ? { ...item, type: v as EmailType } : item))} options={[{ value: "work", label: "Work" }, { value: "personal", label: "Personal" }, { value: "other", label: "Other" }]} />
          <input type="email" value={email.email} onChange={(e) => onChange(emails.map((item, i) => i === index ? { ...item, email: e.target.value } : item))} placeholder="name@company.com" />
          <button type="button" onClick={() => onChange(emails.filter((_, i) => i !== index))}><X size={14} /></button>
        </div>
      ))}
    </section>
  );
}

export default function ContactsPage() {
  const { adminScope, tenantId, tenant, can } = useAppContext();
  // Creating/editing/archiving workspace contacts requires can_manage_contacts.
  // The server enforces the same authoritative gate; viewing is unaffected.
  const canManageContacts = can("can_manage_contacts");
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

  const emailContact = useCallback((contact: Contact) => {
    if (!contact.primaryEmail?.email) return;
    if (contact.type === "internal_extension") {
      router.push(`/team`);
      return;
    }
    router.push(`/crm/contacts/${contact.id}?workspace=email&returnTo=/contacts`);
  }, [router]);

  async function archiveContact(contact: Contact) {
    if (contact.type === "internal_extension") return;
    await apiDelete(`/contacts/${encodeURIComponent(contact.id)}`);
    setSelected(null);
    setReloadKey((key) => key + 1);
  }

  const hasContacts = contacts.length > 0;

  return (
    <PermissionGate permission="can_view_contacts" fallback={<div className="state-box">You do not have contacts access.</div>}>
      <CRMPageShell className={cn(crm.queueWorkspace, "contacts-directory-workspace")} innerClassName={crm.pageInnerQueue}>
        <style jsx global>{CONTACTS_CSS}</style>
        <CRMWorkspaceShell>
          <CRMWorkspaceChrome>
            <CRMWorkspaceHeader>
              <CRMPageHeader
                compact
                className={cn(crm.contactsHeaderPanel, "campaigns-command-header cx-hero")}
                icon={<UserRound className="h-6 w-6" aria-hidden />}
                title="Contacts"
                actions={
                  <div className="cx-hero-actions">
                    <button type="button" className={cn(crm.btnSecondary, "cx-secondary")}><Upload size={16} />Import CSV</button>
                    {canManageContacts ? (
                      <button type="button" className={cn(crm.btnPrimary, "cx-primary")} onClick={() => setEditing(null)}>
                        <Plus size={17} />Add Contact
                      </button>
                    ) : null}
                  </div>
                }
              />
            </CRMWorkspaceHeader>

            {effectiveTenantId && state.status === "success" ? (
              <CRMWorkspaceToolbar className="flex flex-col gap-3">
                <section className="cx-stats crm-queue-kpi-strip" aria-label="Contact metrics">
                  <div className="crm-queue-kpi-card crm-queue-kpi-blue relative overflow-hidden bg-crm-surface-2">
                    <span className="flex w-full items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">Total contacts</span>
                        <strong className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">{data?.stats.total ?? 0}</strong>
                      </span>
                      <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
                        <UserRound className="h-4 w-4" />
                      </span>
                    </span>
                    <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">directory records</span>
                  </div>
                  <div className="crm-queue-kpi-card crm-queue-kpi-green relative overflow-hidden bg-crm-surface-2">
                    <span className="flex w-full items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">Internal extensions</span>
                        <strong className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">{data?.stats.internalExtensions ?? 0}</strong>
                      </span>
                      <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
                        <Phone className="h-4 w-4" />
                      </span>
                    </span>
                    <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">ready extensions</span>
                  </div>
                  <div className="crm-queue-kpi-card crm-queue-kpi-rose relative overflow-hidden bg-crm-surface-2">
                    <span className="flex w-full items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">External contacts</span>
                        <strong className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">{data?.stats.external ?? 0}</strong>
                      </span>
                      <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
                        <Mail className="h-4 w-4" />
                      </span>
                    </span>
                    <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">external people</span>
                  </div>
                  <div className="crm-queue-kpi-card crm-queue-kpi-amber relative overflow-hidden bg-crm-surface-2">
                    <span className="flex w-full items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">Favorites</span>
                        <strong className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">{data?.stats.favorites ?? 0}</strong>
                      </span>
                      <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
                        <Star className="h-4 w-4" />
                      </span>
                    </span>
                    <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">starred contacts</span>
                  </div>
                </section>

                <CRMActionBar className="cx-toolbar crm-queue-filter-bar">
                  <label className="cx-search">
                    <Search size={16} />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, phone, email, extension, company..." />
                  </label>
                  <div className="cx-filters">{FILTERS.map((item) => <button key={item.key} type="button" data-active={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}</div>
                  <div className="cx-view-toggle">
                    <button type="button" data-active={view === "cards"} onClick={() => setView("cards")} aria-label="Card view"><Grid2X2 size={15} /></button>
                    <button type="button" data-active={view === "list"} onClick={() => setView("list")} aria-label="List view"><List size={15} /></button>
                  </div>
                </CRMActionBar>
              </CRMWorkspaceToolbar>
            ) : null}
          </CRMWorkspaceChrome>

          <CRMWorkspaceBody split={Boolean(selected)}>
            <CRMWorkspaceMain className="crm-queue-main-workspace">
              <CRMWorkspaceScrollRegion className="crm-queue-center-workspace flex min-w-0 flex-col gap-3">
                {!effectiveTenantId ? (
                  <EmptyState title="Select a tenant" message="Contacts are tenant-scoped. Choose a tenant to view people and extensions." />
                ) : state.status === "loading" ? (
                  <LoadingSkeleton rows={8} />
                ) : state.status === "error" ? (
                  <ErrorState message={state.error} />
                ) : !hasContacts ? (
                  <EmptyState title="No contacts found" message="No tenant contacts match this view." />
                ) : view === "cards" ? (
                  <section className="cx-grid">
                    {contacts.map((contact) => <ContactCard key={contact.id} contact={contact} status={statuses.get(contact.id) ?? "offline"} onOpen={() => setSelected(contact)} onCall={callContact} onMessage={messageContact} onEmail={emailContact} />)}
                  </section>
                ) : (
                  <ContactList contacts={contacts} statuses={statuses} onOpen={setSelected} onCall={callContact} onMessage={messageContact} onEmail={emailContact} />
                )}
              </CRMWorkspaceScrollRegion>
            </CRMWorkspaceMain>

            {selected ? (
              <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail cx-right-rail flex min-h-0 flex-col">
                <ContactPanel
                  contact={selected}
                  canManage={canManageContacts}
                  status={statuses.get(selected.id) ?? "offline"}
                  onEdit={() => setEditing(selected)}
                  onArchive={() => archiveContact(selected)}
                  onCall={callContact}
                  onMessage={messageContact}
                  onEmail={emailContact}
                />
              </CRMWorkspaceRightRail>
            ) : null}
          </CRMWorkspaceBody>
        </CRMWorkspaceShell>

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
      </CRMPageShell>
    </PermissionGate>
  );
}

const CONTACTS_CSS = `
.contacts-directory-workspace { min-height: 0; background: var(--crm-bg) !important; color: var(--crm-text); }
.contacts-directory-workspace .crm-queue-inner {
  height: 100%;
  max-width: none !important;
  padding: .75rem 1rem !important;
  gap: .75rem !important;
}
.contacts-directory-workspace .crm-workspace-shell,
.contacts-directory-workspace .crm-workspace-chrome,
.contacts-directory-workspace .crm-workspace-body,
.contacts-directory-workspace .crm-workspace-main,
.contacts-directory-workspace .crm-workspace-scroll-region { background: transparent !important; min-height: 0; }
.contacts-directory-workspace .crm-workspace-shell { height: 100%; gap: .75rem !important; }
.contacts-directory-workspace .crm-workspace-chrome { gap: .75rem !important; flex: 0 0 auto; }
.contacts-directory-workspace .crm-workspace-toolbar { gap: .75rem !important; }
.contacts-directory-workspace .crm-workspace-body { gap: .65rem !important; flex: 1 1 auto; }
.contacts-directory-workspace .crm-workspace-body--split {
  grid-template-columns: minmax(0, 1fr) minmax(23rem, 27rem) !important;
}
.contacts-directory-workspace .cx-right-rail {
  min-width: 23rem;
  max-width: 27rem;
  width: 100%;
}
.contacts-directory-workspace .cx-hero {
  min-height: 5.75rem;
  padding: 1.25rem !important;
  border-radius: 1.25rem;
}
:root[data-theme="light"] .contacts-directory-workspace {
  --crm-bg: #eff1f5;
  --crm-surface: #ffffff;
  --crm-surface-2: #f8fafc;
  --crm-border: rgba(194, 211, 231, 0.92);
  --crm-text: #142338;
  --crm-text-muted: #687c92;
  --border: rgba(194, 211, 231, 0.92);
  --panel: #ffffff;
  --panel-2: #f8fafc;
  --text: #142338;
  --text-dim: #687c92;
  --accent: #2563eb;
  background: #eff1f5 !important;
}
:root[data-theme="light"] .contacts-directory-workspace .contacts-header-panel.campaigns-command-header {
  border: 1px solid rgba(194, 211, 231, 0.92) !important;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.99), rgba(247, 250, 255, 0.96)),
    radial-gradient(circle at 100% 0%, rgba(211, 229, 255, 0.52), transparent 35%) !important;
  color: #142338 !important;
  box-shadow:
    0 18px 46px rgba(31, 53, 78, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.9) !important;
}
:root[data-theme="light"] .contacts-directory-workspace .contacts-header-panel.campaigns-command-header h1,
:root[data-theme="light"] .contacts-directory-workspace .contacts-header-panel.campaigns-command-header p {
  color: #142338 !important;
}
:root[data-theme="light"] .contacts-directory-workspace .contacts-header-panel.campaigns-command-header p,
:root[data-theme="light"] .contacts-directory-workspace .cx-stats :is(.crm-queue-kpi-label, .crm-queue-kpi-micro) {
  color: #687c92 !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-stats div,
:root[data-theme="light"] .contacts-directory-workspace .cx-toolbar {
  border: 1px solid rgba(194, 211, 231, 0.92) !important;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(247, 250, 255, 0.95)) !important;
  color: #142338 !important;
  box-shadow: 0 14px 34px rgba(31, 53, 78, 0.07) !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-search,
:root[data-theme="light"] .contacts-directory-workspace .cx-filters button,
:root[data-theme="light"] .contacts-directory-workspace .cx-view-toggle button {
  border-color: rgba(194, 211, 231, 0.92) !important;
  background: rgba(248, 250, 252, 0.92) !important;
  color: #687c92 !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-search input {
  color: #142338 !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-filters button[data-active="true"],
:root[data-theme="light"] .contacts-directory-workspace .cx-view-toggle button[data-active="true"] {
  border-color: transparent !important;
  background: #6366f1 !important;
  color: #ffffff !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-list-head {
  color: #687c92 !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-list-row,
:root[data-theme="light"] .contacts-directory-workspace .cx-panel {
  border-color: rgba(194, 211, 231, 0.82) !important;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.99), rgba(247, 250, 255, 0.96)) !important;
  color: #142338 !important;
  box-shadow: 0 12px 30px rgba(31, 53, 78, 0.06) !important;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-list-row:hover {
  border-color: rgba(99, 102, 241, 0.28) !important;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 1), rgba(248, 251, 255, 0.98)) !important;
}
.cx-kicker { display: inline-flex; align-items: center; gap: 7px; color: var(--accent); font-weight: 850; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
.cx-hero h1 { margin: 0; font-size: clamp(1.45rem, 3vw, 2rem); line-height: 1; }
.cx-hero p { margin: 0; color: var(--text-dim); font-size: 15px; }
.cx-hero-actions, .cx-actions, .cx-panel-actions, .cx-modal-actions { display: flex; gap: 8px; align-items: center; }
.cx-primary, .cx-secondary, .cx-panel-actions button, .cx-panel-actions a, .cx-modal-actions button, .cx-dynamic button { border: 0; border-radius: 999px; min-height: 34px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer; font-weight: 850; }
.cx-primary, .cx-modal-actions button:last-child { color: white; background: linear-gradient(135deg, #6366f1, #8b5cf6); box-shadow: 0 14px 30px rgba(99,102,241,.28); }
.cx-secondary, .cx-modal-actions .ghost { color: var(--text); background: var(--panel-2); border: 1px solid var(--border); }
.contacts-directory-workspace .cx-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; width: 100%; }
.contacts-directory-workspace .cx-stats div {
  min-height: 5.35rem !important;
  padding: .8rem .9rem !important;
  border-radius: 1.15rem !important;
  border: 1px solid var(--crm-border);
  background: var(--crm-surface);
}
.cx-stats :is(.crm-queue-kpi-label, .crm-queue-kpi-micro) { display: block; color: var(--text-dim); }
.cx-stats strong { display: block; }

/* Per-card accent colors so the KPI strip reads at a glance instead of four
   identical washed-out tiles. Each card gets its own hue on the value, a left
   accent bar, and a soft corner glow. */
.contacts-directory-workspace .cx-stats div { position: relative; overflow: hidden; padding-left: 1.15rem !important; }
.contacts-directory-workspace .cx-stats div:nth-child(1) { --kpi-accent: #2563eb; --kpi-accent-soft: rgba(37, 99, 235, 0.14); --team-kpi-accent: #60a5fa; }
.contacts-directory-workspace .cx-stats div:nth-child(2) { --kpi-accent: #7c3aed; --kpi-accent-soft: rgba(124, 58, 237, 0.14); --team-kpi-accent: #45d18a; }
.contacts-directory-workspace .cx-stats div:nth-child(3) { --kpi-accent: #0d9488; --kpi-accent-soft: rgba(13, 148, 136, 0.14); --team-kpi-accent: #ff6873; }
.contacts-directory-workspace .cx-stats div:nth-child(4) { --kpi-accent: #e0a200; --kpi-accent-soft: rgba(217, 119, 6, 0.16); --team-kpi-accent: #f5b84b; }
.contacts-directory-workspace .cx-stats div::before {
  content: ""; position: absolute; left: 0; top: 14px; bottom: 14px; width: 4px;
  border-radius: 0 4px 4px 0; background: var(--kpi-accent); z-index: 2;
}
:root[data-theme="light"] .contacts-directory-workspace .cx-stats div::before { display: none !important; }
.contacts-directory-workspace .cx-stats div::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background: radial-gradient(circle at 115% -10%, var(--kpi-accent-soft), transparent 62%);
}
.contacts-directory-workspace .cx-stats div > * { position: relative; z-index: 1; }
.contacts-directory-workspace .cx-stats strong { color: var(--kpi-accent) !important; }
:root[data-theme="light"] .contacts-directory-workspace .cx-stats div:nth-child(1),
:root[data-theme="light"] .contacts-directory-workspace .cx-stats div:nth-child(2),
:root[data-theme="light"] .contacts-directory-workspace .cx-stats div:nth-child(3),
:root[data-theme="light"] .contacts-directory-workspace .cx-stats div:nth-child(4) {
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.98), var(--kpi-accent-soft)) !important;
  border-color: color-mix(in srgb, var(--kpi-accent) 26%, rgba(194, 211, 231, 0.92)) !important;
}
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats div:nth-child(1),
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats div:nth-child(2),
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats div:nth-child(3),
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats div:nth-child(4) {
  padding: 0.75rem 0.875rem !important;
  background:
    radial-gradient(circle at 96% 0%, rgba(96, 165, 250, 0.11), transparent 32%),
    linear-gradient(180deg, rgba(18, 31, 48, 0.82), rgba(13, 24, 38, 0.72)) !important;
  border-color: rgba(112, 145, 181, 0.24) !important;
  box-shadow:
    0 18px 52px -42px rgba(0, 0, 0, 0.9),
    inset 0 1px 0 rgba(255, 255, 255, 0.043) !important;
}
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats div::before {
  inset: 0 0 auto !important;
  width: auto !important;
  height: 3px !important;
  border-radius: inherit !important;
  background: linear-gradient(90deg, var(--team-kpi-accent), color-mix(in srgb, var(--team-kpi-accent) 38%, transparent)) !important;
}
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats div::after {
  background: none !important;
}
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats :is(.crm-queue-kpi-label, .crm-queue-kpi-micro) {
  color: #9baabb !important;
}
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats strong {
  color: #f4f8fc !important;
  text-shadow: none !important;
}
:root[data-theme="dark"] .contacts-directory-workspace .cx-stats .crm-queue-kpi-icon {
  color: var(--team-kpi-accent) !important;
  border-color: color-mix(in srgb, var(--team-kpi-accent) 40%, transparent) !important;
  background: color-mix(in srgb, var(--team-kpi-accent) 18%, #172336) !important;
  box-shadow: none !important;
}
.contacts-directory-workspace .cx-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: .55rem !important; border-radius: 1rem !important; }
.cx-search { flex: 1; min-width: min(340px, 100%); display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel-2); color: var(--text-dim); }
.cx-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); min-width: 0; }
.cx-filters, .cx-view-toggle { display: flex; align-items: center; gap: 6px; }
.cx-filters button, .cx-view-toggle button { border: 1px solid var(--border); color: var(--text-dim); background: transparent; border-radius: 999px; min-height: 28px; padding: 0 9px; cursor: pointer; font-weight: 850; font-size: .72rem; }
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
.cx-actions a[aria-disabled="true"], .cx-actions button:disabled { opacity: .4; pointer-events: none; }
.cx-star { color: #facc15; }
.cx-list { display: grid; gap: 6px; }
.cx-list-head, .cx-list-row { display: grid; grid-template-columns: 1.7fr .75fr 1fr 1.25fr 1fr 1fr .9fr auto; gap: 10px; align-items: center; }
.cx-list-head { padding: 0 12px; color: var(--text-dim); font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
.cx-list-row { width: 100%; min-height: 2.55rem; text-align: left; border: 1px solid var(--border); border-radius: 13px; padding: 6px 10px; background: var(--panel); color: var(--text); cursor: pointer; }
.cx-list-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cx-list-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-panel { position: relative; width: 100%; height: 100%; min-height: 0; overflow: auto; padding: 16px; border: 1px solid var(--border); border-radius: 1.15rem; background: color-mix(in srgb, var(--panel) 94%, transparent); backdrop-filter: blur(20px); box-shadow: 0 24px 70px -44px rgba(0,0,0,.9); }
.cx-panel-hero { text-align: center; padding: 18px 8px 12px; }
.cx-panel-hero h2 { margin: 12px 0 4px; }
.cx-panel-hero p { margin: 0; color: var(--text-dim); }
.cx-center { justify-content: center; }
.cx-panel-actions { justify-content: center; padding-bottom: 10px; }
.cx-panel-actions button, .cx-panel-actions a { color: var(--text); background: var(--panel-2); border: 1px solid var(--border); text-decoration: none; }
.cx-detail-section { border-top: 1px solid var(--border); padding: 10px 0; }
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
  .contacts-directory-workspace .crm-workspace-body--split { grid-template-columns: 1fr !important; }
  .contacts-directory-workspace .cx-right-rail { min-width: 0; max-width: none; }
}
@media (max-width: 640px) {
  .cx-stats, .cx-form-grid { grid-template-columns: 1fr; }
  .cx-dynamic-row { grid-template-columns: 1fr; }
  .cx-hero-actions { width: 100%; flex-direction: column; align-items: stretch; }
}
`;
