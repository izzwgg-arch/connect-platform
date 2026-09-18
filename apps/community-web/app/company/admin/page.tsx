"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Field, Skeleton, Switch, VChip, fmtDate, timeAgo, useToast } from "@/components/ui";
import { ORG_PERMISSION_LABELS, ORG_PERMISSIONS, ORG_ROLES, type OrgPermission } from "@/components/company/permissions";
import "@/components/company/company.css";

type MyOrg = { id: string; slug: string; displayName: string; role: string };
type Member = {
  person: { id: string; name?: string; username?: string; headline?: string | null; avatarAssetId?: string | null };
  role: string;
  permissions: string[];
  explicitPermissions: string[];
  affiliation: string;
  title: string | null;
  isPrimary: boolean;
  since: string;
};
type Invite = { id: string; email: string; role: string; expiresAt: string; createdAt: string };
type Verification = { id: string; kind: string; status: string; note: string | null; expiresAt: string | null; createdAt: string; reviewedAt: string | null; instructions: string | null };
type OrgDetail = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string | null;
  industry: string | null;
  size: string | null;
  foundedYear: number | null;
  website: string | null;
  domain: string | null;
  phone: string | null;
  smsNumber: string | null;
  whatsappNumber: string | null;
  email: string | null;
  description: string | null;
  serviceArea: string[];
  hours: Partial<Record<string, [string, string] | "closed">> | null;
  acceptsRfqs: boolean;
  showPhone: boolean;
  showEmail: boolean;
  showWhatsapp: boolean;
  openMessages: boolean;
  searchEngineVisible: boolean;
  myPermissions: string[];
};
type Location = { id: string; label: string; address1: string | null; city: string | null; region: string | null; postalCode: string | null; country: string; phone: string | null; isHeadquarters: boolean };
type AuditRow = { id: string; action: string; targetType: string; targetId: string | null; before: unknown; after: unknown; createdAt: string; actorId: string | null };

const DAYS = [
  ["sun", "Sun"],
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
] as const;
const TABS = ["members", "verification", "page", "locations", "audit"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { members: "Members & roles", verification: "Verification", page: "Page", locations: "Locations", audit: "Audit log" };

function has(perms: string[], p: OrgPermission) {
  return perms.includes(p);
}

/* ── Members & roles ────────────────────────────────────────────────────── */
function MembersTab({ orgId, myPermissions, meId }: { orgId: string; myPermissions: string[]; meId: string }) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [permsFor, setPermsFor] = useState<Member | null>(null);

  const load = useCallback(() => {
    api<{ members: Member[] }>(`/organizations/${orgId}/members`).then((r) => setMembers(r.members));
    if (has(myPermissions, "org.manage_members")) api<{ invites: Invite[] }>(`/organizations/${orgId}/invites`).then((r) => setInvites(r.invites));
  }, [orgId, myPermissions]);
  useEffect(load, [load]);

  const canManageRoles = has(myPermissions, "org.manage_roles");
  const canManageMembers = has(myPermissions, "org.manage_members");

  async function setRole(personId: string, role: string) {
    try {
      await api(`/organizations/${orgId}/members/${personId}`, { method: "PATCH", body: { role } });
      toast("Role updated.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }
  async function setAffiliation(personId: string, affiliation: string) {
    try {
      await api(`/organizations/${orgId}/members/${personId}`, { method: "PATCH", body: { affiliation } });
      toast(affiliation === "VERIFIED_ADMIN" ? "Approved." : "Rejected.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }
  async function remove(personId: string) {
    try {
      await api(`/organizations/${orgId}/members/${personId}`, { method: "DELETE" });
      toast("Member removed.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <b>
            {members?.length ?? "…"} members{invites ? ` · ${invites.length} pending invite${invites.length === 1 ? "" : "s"}` : ""}
          </b>
          {canManageMembers ? (
            <Button kind="p" icon="plus" onClick={() => setInviteOpen(true)} data-testid="company-admin-invite-open">
              Invite member
            </Button>
          ) : null}
        </div>
        {members === null ? (
          <Skeleton h={80} />
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Affiliation</th>
                  <th>Permissions</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.person.id} data-testid={`company-admin-member-${m.person.id}`}>
                    <td>
                      <div className="row">
                        <Avatar name={m.person.name ?? "?"} assetId={m.person.avatarAssetId} size={30} />
                        <b>{m.person.name ?? m.person.id}</b>
                      </div>
                    </td>
                    <td>
                      {canManageRoles ? (
                        <select className="in" value={m.role} onChange={(e) => setRole(m.person.id, e.target.value)} aria-label={`Role for ${m.person.name}`} data-testid={`company-admin-role-${m.person.id}`}>
                          {ORG_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Chip kind={m.role === "OWNER" ? "ac" : ""}>{m.role}</Chip>
                      )}
                    </td>
                    <td>
                      {m.affiliation === "PENDING" ? (
                        <div className="row">
                          <Chip kind="warn" icon="clock">Pending</Chip>
                          {canManageRoles ? (
                            <>
                              <Button small kind="p" onClick={() => setAffiliation(m.person.id, "VERIFIED_ADMIN")} data-testid={`company-admin-approve-${m.person.id}`}>
                                Approve
                              </Button>
                              <Button small kind="g" onClick={() => setAffiliation(m.person.id, "REJECTED")}>
                                Reject
                              </Button>
                            </>
                          ) : null}
                        </div>
                      ) : m.affiliation === "REJECTED" ? (
                        <Chip kind="bad">Rejected</Chip>
                      ) : (
                        <VChip>{m.affiliation === "VERIFIED_DOMAIN" ? "Verified · domain" : "Verified · admin"}</VChip>
                      )}
                    </td>
                    <td>
                      <Button small kind="g" onClick={() => setPermsFor(m)} data-testid={`company-admin-permissions-${m.person.id}`}>
                        {m.permissions.length} keys
                      </Button>
                    </td>
                    <td>
                      {canManageMembers && m.person.id !== meId ? (
                        <Button small kind="g d" icon="trash" onClick={() => remove(m.person.id)} data-testid={`company-admin-remove-${m.person.id}`}>
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {invites && invites.length > 0 ? (
        <div className="card">
          <div className="ct">Pending invites</div>
          <div className="list sm">
            {invites.map((i) => (
              <div className="li" key={i.id}>
                <div className="t">
                  <b>{i.email}</b>
                  <small>
                    {i.role} · sent {timeAgo(i.createdAt)}
                  </small>
                </div>
                {canManageMembers ? (
                  <Button
                    small
                    kind="g d"
                    onClick={async () => {
                      await api(`/organizations/${orgId}/invites/${i.id}`, { method: "DELETE" });
                      setInvites(invites.filter((x) => x.id !== i.id));
                    }}
                    data-testid={`company-admin-revoke-${i.id}`}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSent={() => {
          setInviteOpen(false);
          load();
        }}
        orgId={orgId}
      />
      {permsFor ? <PermissionsDialog member={permsFor} orgId={orgId} onClose={() => setPermsFor(null)} onSaved={load} /> : null}
    </>
  );
}

function InviteDialog({ open, onClose, onSent, orgId }: { open: boolean; onClose: () => void; onSent: () => void; orgId: string }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("EMPLOYEE");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title="Invite a member">
      <div className="col" style={{ gap: 10, marginTop: 10 }}>
        <Field label="Email" htmlFor="inv-email">
          <input id="inv-email" className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="company-admin-invite-email" />
        </Field>
        <Field label="Role" htmlFor="inv-role">
          <select id="inv-role" className="in" value={role} onChange={(e) => setRole(e.target.value)} data-testid="company-admin-invite-role">
            {ORG_ROLES.filter((r) => r !== "CUSTOM").map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Button
          kind="p"
          loading={busy}
          data-testid="company-admin-invite-send"
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/organizations/${orgId}/invites`, { method: "POST", body: { email, role }, idempotencyKey: newIdempotencyKey() });
              toast(`Invited ${email}.`);
              setEmail("");
              onSent();
            } catch (err) {
              toast((err as ApiError).message, { kind: "err" });
            } finally {
              setBusy(false);
            }
          }}
        >
          Send invite
        </Button>
      </div>
    </Dialog>
  );
}

function PermissionsDialog({ member, orgId, onClose, onSaved }: { member: Member; orgId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set(member.explicitPermissions));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title={`Extra permissions for ${member.person.name ?? member.person.id}`} wide>
      <p className="sm dim" style={{ marginTop: 8 }}>
        The <b>{member.role}</b> role already includes some of these. These toggles grant EXTRA keys on top of the role.
      </p>
      <div className="company-perm-grid" style={{ marginTop: 10 }}>
        {ORG_PERMISSIONS.map((p) => (
          <div className="li" key={p} style={{ padding: "4px 0" }}>
            <div className="t">
              <b style={{ fontWeight: 500 }}>{ORG_PERMISSION_LABELS[p]}</b>
            </div>
            <Switch
              on={selected.has(p)}
              label={ORG_PERMISSION_LABELS[p]}
              onChange={(v) => {
                const next = new Set(selected);
                if (v) next.add(p);
                else next.delete(p);
                setSelected(next);
              }}
            />
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <Button
          kind="p"
          loading={busy}
          data-testid="company-admin-permissions-save"
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/organizations/${orgId}/members/${member.person.id}`, { method: "PATCH", body: { permissions: [...selected] } });
              toast("Permissions saved.");
              onSaved();
              onClose();
            } catch (err) {
              toast((err as ApiError).message, { kind: "err" });
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      </div>
    </Dialog>
  );
}

/* ── Verification ───────────────────────────────────────────────────────── */
function VerificationTab({ orgId, domain, myPermissions }: { orgId: string; domain: string | null; myPermissions: string[] }) {
  const toast = useToast();
  const [rows, setRows] = useState<Verification[] | null>(null);
  const canVerify = has(myPermissions, "org.verify");
  const load = useCallback(() => {
    api<{ verifications: Verification[] }>(`/organizations/${orgId}/verifications`).then((r) => setRows(r.verifications));
  }, [orgId]);
  useEffect(load, [load]);

  async function request(kind: string) {
    try {
      const r = await api<any>(`/organizations/${orgId}/verifications`, { method: "POST", body: { kind } });
      toast(r.status === "VERIFIED" ? "Verified." : r.status === "PENDING" && r.instructions ? "Pending — see the DNS instructions below." : "Submitted for review.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }
  async function recheck(id: string) {
    try {
      const r = await api<any>(`/organizations/${orgId}/verifications/${id}/recheck`, { method: "POST" });
      toast(r.status === "VERIFIED" ? "Domain verified!" : "Still pending — DNS may take a while to update.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <div className="card">
      <div className="ct">Verification</div>
      {rows === null ? (
        <Skeleton h={60} />
      ) : rows.length === 0 ? (
        <Empty title="No verification requests yet" />
      ) : (
        <div className="list sm">
          {rows.map((v) => (
            <div className="li" key={v.id} style={{ alignItems: "flex-start" }} data-testid={`company-admin-verification-${v.id}`}>
              <Chip kind={v.status === "VERIFIED" ? "ok" : v.status === "REJECTED" ? "bad" : "warn"} icon={v.status === "VERIFIED" ? "check" : "clock"}>
                {v.status === "VERIFIED" ? "Verified" : v.status === "REJECTED" ? "Rejected" : "Pending"}
              </Chip>
              <div className="t">
                <b>{v.kind}</b>
                <small>
                  {v.status === "VERIFIED" ? `Verified${v.reviewedAt ? " " + fmtDate(v.reviewedAt) : ""}` : v.status === "REJECTED" ? v.note ?? "Rejected" : "Pending review"}
                  {v.expiresAt ? ` · expires ${fmtDate(v.expiresAt)}` : ""}
                </small>
                {v.instructions ? <p className="sm" style={{ marginTop: 6 }}>{v.instructions}</p> : null}
              </div>
              {v.kind === "DOMAIN" && v.status === "PENDING" && canVerify ? (
                <Button small onClick={() => recheck(v.id)} data-testid={`company-admin-recheck-${v.id}`}>
                  Recheck
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {canVerify ? (
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <Button kind="g" small onClick={() => request("BUSINESS")} data-testid="company-admin-verify-business">
            Request business verification
          </Button>
          <Button kind="g" small onClick={() => request("INSURANCE")} data-testid="company-admin-verify-insurance">
            Add insurance
          </Button>
          <Button kind="g" small onClick={() => request("LICENSE")} data-testid="company-admin-verify-license">
            Add a license
          </Button>
          <Button kind="g" small disabled={!domain} title={domain ? undefined : "Set a domain in Page settings first"} onClick={() => request("DOMAIN")} data-testid="company-admin-verify-domain">
            Verify domain {domain ? `(${domain})` : ""}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ── Page settings ─────────────────────────────────────────────────────── */
function PageTab({ org, onSaved }: { org: OrgDetail; onSaved: (o: OrgDetail) => void }) {
  const toast = useToast();
  const [form, setForm] = useState(org);
  const [busy, setBusy] = useState(false);
  const canEdit = has(org.myPermissions, "org.edit_page");
  useEffect(() => setForm(org), [org]);

  function field<K extends keyof OrgDetail>(key: K, value: OrgDetail[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function dayHour(day: string, idx: 0 | 1, value: string) {
    const current = form.hours?.[day];
    const base: [string, string] = Array.isArray(current) ? current : ["09:00", "17:00"];
    base[idx] = value;
    field("hours", { ...(form.hours ?? {}), [day]: base });
  }
  function toggleClosed(day: string, closed: boolean) {
    field("hours", { ...(form.hours ?? {}), [day]: closed ? "closed" : ["09:00", "17:00"] });
  }

  async function save() {
    setBusy(true);
    try {
      const updated = await api<OrgDetail>(`/organizations/${org.id}`, {
        method: "PATCH",
        body: {
          displayName: form.displayName,
          legalName: form.legalName,
          industry: form.industry,
          size: form.size,
          foundedYear: form.foundedYear,
          website: form.website,
          domain: form.domain,
          phone: form.phone,
          smsNumber: form.smsNumber,
          whatsappNumber: form.whatsappNumber,
          email: form.email,
          description: form.description,
          serviceArea: form.serviceArea,
          hours: form.hours,
          acceptsRfqs: form.acceptsRfqs,
          showPhone: form.showPhone,
          showEmail: form.showEmail,
          showWhatsapp: form.showWhatsapp,
          openMessages: form.openMessages,
          searchEngineVisible: form.searchEngineVisible,
        },
      });
      onSaved({ ...updated, myPermissions: org.myPermissions } as OrgDetail);
      toast("Page settings saved.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage(kind: "logo" | "cover", file: File) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api(`/organizations/${org.id}/${kind}`, { method: "POST", form: fd });
      toast(`${kind === "logo" ? "Logo" : "Cover"} updated.`);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <>
      <div className="card">
        <div className="ct">Company details</div>
        <div className="grid2">
          <Field label="Company name" htmlFor="p-name"><input id="p-name" className="in" disabled={!canEdit} value={form.displayName} onChange={(e) => field("displayName", e.target.value)} /></Field>
          <Field label="Legal name" htmlFor="p-legal"><input id="p-legal" className="in" disabled={!canEdit} value={form.legalName ?? ""} onChange={(e) => field("legalName", e.target.value || null)} /></Field>
          <Field label="Industry" htmlFor="p-ind"><input id="p-ind" className="in" disabled={!canEdit} value={form.industry ?? ""} onChange={(e) => field("industry", e.target.value || null)} /></Field>
          <Field label="Company size" htmlFor="p-size"><input id="p-size" className="in" disabled={!canEdit} value={form.size ?? ""} onChange={(e) => field("size", e.target.value || null)} /></Field>
          <Field label="Founded year" htmlFor="p-year"><input id="p-year" className="in" type="number" disabled={!canEdit} value={form.foundedYear ?? ""} onChange={(e) => field("foundedYear", e.target.value ? Number(e.target.value) : null)} /></Field>
          <Field label="Website" htmlFor="p-web"><input id="p-web" className="in" disabled={!canEdit} value={form.website ?? ""} onChange={(e) => field("website", e.target.value || null)} /></Field>
          <Field label="Domain" htmlFor="p-domain" help="For domain verification.">
            <input id="p-domain" className="in" disabled={!canEdit} value={form.domain ?? ""} onChange={(e) => field("domain", e.target.value || null)} data-testid="company-admin-domain" />
          </Field>
          <Field label="Phone" htmlFor="p-phone"><input id="p-phone" className="in" disabled={!canEdit} value={form.phone ?? ""} onChange={(e) => field("phone", e.target.value || null)} /></Field>
          <Field label="WhatsApp number" htmlFor="p-wa"><input id="p-wa" className="in" disabled={!canEdit} value={form.whatsappNumber ?? ""} onChange={(e) => field("whatsappNumber", e.target.value || null)} /></Field>
          <Field label="Email" htmlFor="p-email"><input id="p-email" className="in" disabled={!canEdit} value={form.email ?? ""} onChange={(e) => field("email", e.target.value || null)} /></Field>
        </div>
        <Field label="About" htmlFor="p-desc">
          <textarea id="p-desc" className="in" style={{ minHeight: 90 }} disabled={!canEdit} value={form.description ?? ""} onChange={(e) => field("description", e.target.value || null)} />
        </Field>
        <Field label="Service area" htmlFor="p-area" help="Comma-separated (e.g. Monroe, Boro Park, Lakewood).">
          <input id="p-area" className="in" disabled={!canEdit} value={form.serviceArea.join(", ")} onChange={(e) => field("serviceArea", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </Field>
      </div>

      <div className="card">
        <div className="ct">Logo &amp; cover</div>
        <div className="row" style={{ gap: 20 }}>
          <Field label="Logo" htmlFor="p-logo"><input id="p-logo" type="file" accept="image/*" disabled={!canEdit} onChange={(e) => e.target.files?.[0] && uploadImage("logo", e.target.files[0])} data-testid="company-admin-logo-upload" /></Field>
          <Field label="Cover photo" htmlFor="p-cover"><input id="p-cover" type="file" accept="image/*" disabled={!canEdit} onChange={(e) => e.target.files?.[0] && uploadImage("cover", e.target.files[0])} data-testid="company-admin-cover-upload" /></Field>
        </div>
      </div>

      <div className="card">
        <div className="ct">Hours</div>
        <div className="company-hours-grid">
          {DAYS.map(([key, label]) => {
            const v = form.hours?.[key];
            const closed = v === "closed";
            const [open, close] = Array.isArray(v) ? v : ["09:00", "17:00"];
            return (
              <div key={key} className="row" style={{ display: "contents" }}>
                <b className="sm">{label}</b>
                <input className="in" type="time" disabled={!canEdit || closed} value={open} onChange={(e) => dayHour(key, 0, e.target.value)} />
                <input className="in" type="time" disabled={!canEdit || closed} value={close} onChange={(e) => dayHour(key, 1, e.target.value)} />
                <label className="row xs" style={{ gap: 4 }}>
                  <input type="checkbox" disabled={!canEdit} checked={closed} onChange={(e) => toggleClosed(key, e.target.checked)} /> Closed
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="ct">Page settings</div>
        <div className="list sm">
          {(
            [
              ["showPhone", "Show phone number"],
              ["showWhatsapp", "Show WhatsApp"],
              ["showEmail", "Show email"],
              ["acceptsRfqs", "Accept RFQs"],
              ["openMessages", "Accept message requests from anyone"],
              ["searchEngineVisible", "Visible to search engines"],
            ] as const
          ).map(([key, label]) => (
            <div className="li" style={{ alignItems: "center" }} key={key}>
              <div className="t">
                <b style={{ fontWeight: 500 }}>{label}</b>
              </div>
              <Switch on={form[key] as boolean} label={label} onChange={(v) => field(key, v as any)} id={`company-admin-page-${key}`} />
            </div>
          ))}
        </div>
      </div>
      {canEdit ? (
        <div className="row">
          <Button kind="p" loading={busy} onClick={save} data-testid="company-admin-page-save">
            Save changes
          </Button>
        </div>
      ) : null}
    </>
  );
}

/* ── Locations ──────────────────────────────────────────────────────────── */
function LocationsTab({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<Location[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const load = useCallback(() => {
    void api<{ locations: Location[] }>(`/organizations/${orgId}/locations`).then((r) => setRows(r.locations));
  }, [orgId]);
  useEffect(load, [load]);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <b>Locations</b>
        {canManage ? (
          <Button kind="p" icon="plus" onClick={() => { setEditing(null); setOpen(true); }} data-testid="company-admin-location-add">
            Add location
          </Button>
        ) : null}
      </div>
      {rows === null ? (
        <Skeleton h={60} />
      ) : rows.length === 0 ? (
        <Empty title="No locations yet" />
      ) : (
        <div className="list">
          {rows.map((l) => (
            <div className="li" key={l.id} data-testid={`company-admin-location-${l.id}`}>
              <div className="t">
                <b>
                  {l.label} {l.isHeadquarters ? <Chip kind="ac">HQ</Chip> : null}
                </b>
                <small>{[l.address1, l.city, l.region, l.postalCode].filter(Boolean).join(", ")}</small>
              </div>
              {canManage ? (
                <div className="row">
                  <Button small kind="g" onClick={() => { setEditing(l); setOpen(true); }}>
                    Edit
                  </Button>
                  <Button
                    small
                    kind="g d"
                    onClick={async () => {
                      await api(`/organizations/${orgId}/locations/${l.id}`, { method: "DELETE" });
                      load();
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <LocationDialog
        open={open}
        orgId={orgId}
        editing={editing}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          load();
        }}
      />
    </div>
  );
}

function LocationDialog({ open, orgId, editing, onClose, onSaved }: { open: boolean; orgId: string; editing: Location | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<Partial<Location>>(editing ?? { country: "US" });
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(editing ?? { country: "US" }), [editing, open]);
  return (
    <Dialog open={open} onClose={onClose} title={editing ? "Edit location" : "Add a location"}>
      <div className="col" style={{ gap: 10, marginTop: 10 }}>
        <Field label="Label" htmlFor="loc-label"><input id="loc-label" className="in" value={form.label ?? ""} onChange={(e) => setForm({ ...form, label: e.target.value })} data-testid="company-admin-location-label" /></Field>
        <Field label="Address" htmlFor="loc-addr"><input id="loc-addr" className="in" value={form.address1 ?? ""} onChange={(e) => setForm({ ...form, address1: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="City" htmlFor="loc-city"><input id="loc-city" className="in" value={form.city ?? ""} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
          <Field label="Region" htmlFor="loc-region"><input id="loc-region" className="in" value={form.region ?? ""} onChange={(e) => setForm({ ...form, region: e.target.value })} /></Field>
          <Field label="Postal code" htmlFor="loc-postal"><input id="loc-postal" className="in" value={form.postalCode ?? ""} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></Field>
          <Field label="Phone" htmlFor="loc-phone"><input id="loc-phone" className="in" value={form.phone ?? ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <label className="row xs" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!form.isHeadquarters} onChange={(e) => setForm({ ...form, isHeadquarters: e.target.checked })} /> Headquarters
        </label>
        <Button
          kind="p"
          loading={busy}
          data-testid="company-admin-location-save"
          onClick={async () => {
            if (!form.label) return;
            setBusy(true);
            try {
              if (editing) await api(`/organizations/${orgId}/locations/${editing.id}`, { method: "PATCH", body: form });
              else await api(`/organizations/${orgId}/locations`, { method: "POST", body: form, idempotencyKey: newIdempotencyKey() });
              onSaved();
            } catch (err) {
              toast((err as ApiError).message, { kind: "err" });
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      </div>
    </Dialog>
  );
}

/* ── Audit log ──────────────────────────────────────────────────────────── */
function AuditTab({ orgId }: { orgId: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  const loadMore = useCallback(
    async (reset = false) => {
      setLoading(true);
      const r = await api<{ items: AuditRow[]; nextCursor: string | null }>(`/organizations/${orgId}/audit${!reset && cursor ? `?cursor=${cursor}` : ""}`);
      setRows((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor);
      setDone(!r.nextCursor);
      setLoading(false);
    },
    [orgId, cursor],
  );
  useEffect(() => {
    setRows([]);
    setCursor(null);
    setDone(false);
    loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return (
    <div className="card">
      <div className="ct">Audit log</div>
      {rows.length === 0 && loading ? (
        <Skeleton h={80} />
      ) : rows.length === 0 ? (
        <Empty title="No activity recorded yet" />
      ) : (
        <div className="list sm">
          {rows.map((r) => (
            <div className="li" key={r.id}>
              <div className="t">
                <b>{r.action}</b>
                <small className="mono">{fmtDate(r.createdAt, { month: "short", day: "numeric", year: "numeric" })} · {timeAgo(r.createdAt)}</small>
              </div>
            </div>
          ))}
        </div>
      )}
      {!done ? (
        <div className="row" style={{ marginTop: 10 }}>
          <Button kind="g" small loading={loading} onClick={() => loadMore(false)} data-testid="company-admin-audit-more">
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ── Page shell ─────────────────────────────────────────────────────────── */
function CompanyAdmin() {
  const [orgs, setOrgs] = useState<MyOrg[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [tab, setTab] = useState<Tab>("members");
  const [meId, setMeId] = useState<string>("");

  useEffect(() => {
    api<{ organizations: MyOrg[] }>("/me/organizations").then((r) => {
      setOrgs(r.organizations);
      if (r.organizations.length) setOrgId(r.organizations[0].id);
    });
    api<{ person: { id: string } }>("/auth/me").then((r) => setMeId(r.person.id)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!orgId) return;
    api<OrgDetail>(`/organizations/${orgId}`).then(setDetail);
  }, [orgId]);

  if (orgs === null) return <div className="card"><Skeleton h={120} /></div>;
  if (orgs.length === 0)
    return (
      <div className="card">
        <Empty title="You don't manage a company page yet" text="Create one from Company pages first." action={<Button kind="p" href="/company">Go to Company pages</Button>} />
      </div>
    );

  return (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      {orgs.length > 1 ? (
        <div className="card tight" style={{ marginBottom: 4 }}>
          <select className="in" value={orgId ?? ""} onChange={(e) => setOrgId(e.target.value)} aria-label="Company" data-testid="company-admin-org-select">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-testid={`company-admin-tab-${t}`}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {!detail || !orgId ? (
        <div className="card">
          <Skeleton h={120} />
        </div>
      ) : tab === "members" ? (
        <MembersTab orgId={orgId} myPermissions={detail.myPermissions} meId={meId} />
      ) : tab === "verification" ? (
        <VerificationTab orgId={orgId} domain={detail.domain} myPermissions={detail.myPermissions} />
      ) : tab === "page" ? (
        <PageTab org={detail} onSaved={setDetail} />
      ) : tab === "locations" ? (
        <LocationsTab orgId={orgId} canManage={has(detail.myPermissions, "org.manage_locations")} />
      ) : (
        <AuditTab orgId={orgId} />
      )}
    </div>
  );
}

export default function CompanyAdminPage() {
  return (
    <RequireAuth>
      <AppShell title="Company admin">
        <CompanyAdmin />
      </AppShell>
    </RequireAuth>
  );
}
