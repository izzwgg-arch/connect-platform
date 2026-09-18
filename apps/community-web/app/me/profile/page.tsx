"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, mediaUrl, newIdempotencyKey } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Dialog, Field, Skeleton, useToast } from "@/components/ui";
import "@/components/profile/profile.css";

type LinkRow = { label: string; url: string };
type ExperienceRow = { id: string; organizationId: string | null; companyName: string; title: string; startDate: string; endDate: string | null; isCurrent: boolean; location: string | null; description: string | null };
type EducationRow = { id: string; school: string; degree: string | null; field: string | null; startYear: number | null; endYear: number | null };
type ServiceRow = { id: string; name: string; description: string | null; priceFrom: string | null; priceNote: string | null };
type CertificationRow = { id: string; name: string; issuer: string | null; issuedAt: string | null; expiresAt: string | null };
type PortfolioRow = { id: string; title: string; description: string | null; url: string | null };

type FullProfile = {
  personId: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  about: string | null;
  avatarAssetId: string | null;
  coverAssetId: string | null;
  location: string | null;
  serviceArea: string[];
  languages: string[];
  industry: string | null;
  objectives: string[];
  skills: string[];
  links: LinkRow[];
  experiences: ExperienceRow[];
  educations: EducationRow[];
  services: ServiceRow[];
  certifications: CertificationRow[];
  portfolio: PortfolioRow[];
};

export default function MyProfileEditorPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function ChipEditor({ values, onChange, placeholder, max = 20, testId }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; max?: number; testId: string }) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v || values.includes(v) || values.length >= max) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }
  return (
    <div className="profile-chip-input">
      {values.map((v) => (
        <Chip key={v} icon="x" onClick={() => onChange(values.filter((x) => x !== v))} title={`Remove ${v}`}>
          {v}
        </Chip>
      ))}
      <input
        className="in"
        style={{ width: 170 }}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        data-testid={`${testId}-input`}
      />
      <Button small onClick={add} data-testid={`${testId}-add`}>
        Add
      </Button>
    </div>
  );
}

function Inner() {
  const { reload } = useAuth();
  const toast = useToast();
  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [username, setUsername] = useState("");
  const [usernameBusy, setUsernameBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<"avatar" | "cover" | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api<{ profile: FullProfile; username: string }>("/me/profile");
      setProfile(r.profile);
      setUsername(r.username);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading || !profile) {
    return (
      <AppShell title="Edit profile">
        <div className="col">
          <Skeleton h={160} />
          <Skeleton h={220} />
        </div>
      </AppShell>
    );
  }

  function patch<K extends keyof FullProfile>(key: K, value: FullProfile[K]) {
    setProfile((p) => (p ? { ...p, [key]: value } : p));
  }

  async function saveBasics() {
    if (!profile) return;
    setSaving(true);
    try {
      const r = await api<{ profile: FullProfile }>("/me/profile", {
        method: "PATCH",
        body: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          headline: profile.headline,
          about: profile.about,
          location: profile.location,
          industry: profile.industry,
          serviceArea: profile.serviceArea,
          languages: profile.languages,
          objectives: profile.objectives,
          skills: profile.skills,
          links: profile.links,
        },
      });
      setProfile((p) => (p ? { ...p, ...r.profile } : p));
      await reload();
      toast("Profile saved.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind: "avatar" | "cover", file: File) {
    setUploading(kind);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api<{ asset: { id: string } }>(`/me/${kind}`, { method: "POST", form, idempotencyKey: newIdempotencyKey() });
      patch(kind === "avatar" ? "avatarAssetId" : "coverAssetId", r.asset.id as any);
      await reload();
      toast(kind === "avatar" ? "Photo updated." : "Cover photo updated.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setUploading(null);
    }
  }

  async function saveUsername() {
    setUsernameBusy(true);
    try {
      const r = await api<{ username: string }>("/me/username", { method: "PATCH", body: { username } });
      setUsername(r.username);
      await reload();
      toast("Username updated.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setUsernameBusy(false);
    }
  }

  return (
    <AppShell title="Edit profile">
      <div className="profile-editor-grid" style={{ gridColumn: "1/-1", maxWidth: 860 }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="profile-cover-wrap">
            <div className="cover">{profile.coverAssetId ? <img src={mediaUrl(profile.coverAssetId, "medium") ?? undefined} alt="" /> : null}</div>
            <Button small className="profile-upload-btn" onClick={() => coverInput.current?.click()} loading={uploading === "cover"} data-testid="profile-editor-cover-upload">
              Change cover
            </Button>
            <input ref={coverInput} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && void upload("cover", e.target.files[0])} data-testid="profile-editor-cover-input" />
          </div>
          <div style={{ padding: "0 20px 20px" }}>
            <div className="profile-avatar-upload" style={{ marginTop: -34, width: 84 }}>
              <Avatar name={`${profile.firstName} ${profile.lastName}`} assetId={profile.avatarAssetId} size={84} />
              <Button small className="profile-avatar-upload-btn" icon="cam" onClick={() => avatarInput.current?.click()} loading={uploading === "avatar"} data-testid="profile-editor-avatar-upload" aria-label="Change photo">
                {""}
              </Button>
              <input ref={avatarInput} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && void upload("avatar", e.target.files[0])} data-testid="profile-editor-avatar-input" />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ct">Basic info</div>
          <div className="grid2">
            <Field label="First name" htmlFor="pf-first">
              <input id="pf-first" className="in" value={profile.firstName} onChange={(e) => patch("firstName", e.target.value)} data-testid="profile-editor-firstname" />
            </Field>
            <Field label="Last name" htmlFor="pf-last">
              <input id="pf-last" className="in" value={profile.lastName} onChange={(e) => patch("lastName", e.target.value)} data-testid="profile-editor-lastname" />
            </Field>
          </div>
          <Field label="Headline" htmlFor="pf-headline" help="Shown right under your name.">
            <input id="pf-headline" className="in" maxLength={140} value={profile.headline ?? ""} onChange={(e) => patch("headline", e.target.value)} data-testid="profile-editor-headline" />
          </Field>
          <Field label="About" htmlFor="pf-about">
            <textarea id="pf-about" className="in" rows={4} maxLength={4000} value={profile.about ?? ""} onChange={(e) => patch("about", e.target.value)} data-testid="profile-editor-about" />
          </Field>
          <div className="grid2">
            <Field label="Location" htmlFor="pf-location">
              <input id="pf-location" className="in" value={profile.location ?? ""} onChange={(e) => patch("location", e.target.value)} data-testid="profile-editor-location" />
            </Field>
            <Field label="Industry" htmlFor="pf-industry">
              <input id="pf-industry" className="in" value={profile.industry ?? ""} onChange={(e) => patch("industry", e.target.value)} data-testid="profile-editor-industry" />
            </Field>
          </div>
          <Field label="Service area" htmlFor="pf-area" help="Places you serve.">
            <ChipEditor values={profile.serviceArea} onChange={(v) => patch("serviceArea", v)} placeholder="Add a place" max={20} testId="profile-editor-servicearea" />
          </Field>
          <Field label="Languages" htmlFor="pf-langs">
            <ChipEditor values={profile.languages} onChange={(v) => patch("languages", v)} placeholder="Add a language" max={10} testId="profile-editor-languages" />
          </Field>
          <Field label="Skills" htmlFor="pf-skills">
            <ChipEditor values={profile.skills} onChange={(v) => patch("skills", v)} placeholder="Add a skill" max={50} testId="profile-editor-skills" />
          </Field>
          <Field label="Looking for" htmlFor="pf-obj" help="e.g. Customers, Vendors, Referrals, Partnerships.">
            <ChipEditor values={profile.objectives} onChange={(v) => patch("objectives", v)} placeholder="Add an objective" max={10} testId="profile-editor-objectives" />
          </Field>
          <LinksEditor links={profile.links} onChange={(v) => patch("links", v)} />
          <div className="row" style={{ marginTop: 12 }}>
            <Button kind="p" onClick={saveBasics} loading={saving} data-testid="profile-editor-save">
              Save changes
            </Button>
          </div>
        </div>

        <div className="card">
          <div className="ct">Username</div>
          <div className="row">
            <span className="dim">loopcom.community/people/</span>
            <input className="in" style={{ maxWidth: 220 }} value={username} onChange={(e) => setUsername(e.target.value)} data-testid="profile-editor-username" aria-label="Username" />
            <Button onClick={saveUsername} loading={usernameBusy} data-testid="profile-editor-username-save">
              Save
            </Button>
          </div>
        </div>

        <ExperienceSection experiences={profile.experiences} onChange={(v) => patch("experiences", v)} />
        <EducationSection educations={profile.educations} onChange={(v) => patch("educations", v)} />
        <ServiceSection services={profile.services} onChange={(v) => patch("services", v)} />
        <CertificationSection certifications={profile.certifications} onChange={(v) => patch("certifications", v)} />
        <PortfolioSection portfolio={profile.portfolio} onChange={(v) => patch("portfolio", v)} />
      </div>
    </AppShell>
  );
}

function LinksEditor({ links, onChange }: { links: LinkRow[]; onChange: (v: LinkRow[]) => void }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const toast = useToast();
  function add() {
    if (!label.trim() || !url.trim()) return;
    try {
      new URL(url.trim());
    } catch {
      toast("Enter a full URL, like https://example.com", { kind: "err" });
      return;
    }
    if (links.length >= 10) return;
    onChange([...links, { label: label.trim(), url: url.trim() }]);
    setLabel("");
    setUrl("");
  }
  return (
    <Field label="Links" htmlFor="pf-link-label">
      <div className="list sm" style={{ marginBottom: 6 }}>
        {links.map((l, i) => (
          <div className="li" key={`${l.url}-${i}`} style={{ alignItems: "center" }}>
            <div className="t">
              <b>{l.label}</b>
              <small>{l.url}</small>
            </div>
            <button type="button" className="ib" aria-label={`Remove ${l.label}`} onClick={() => onChange(links.filter((_, idx) => idx !== i))} data-testid={`profile-editor-link-remove-${i}`}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="row">
        <input id="pf-link-label" className="in" style={{ maxWidth: 140 }} placeholder="Label (Website)" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="profile-editor-link-label" />
        <input className="in" style={{ flex: 1 }} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="profile-editor-link-url" />
        <Button small onClick={add} data-testid="profile-editor-link-add">
          Add
        </Button>
      </div>
    </Field>
  );
}

/* ── Experience ─────────────────────────────────────────────────────────── */
function ExperienceSection({ experiences, onChange }: { experiences: ExperienceRow[]; onChange: (v: ExperienceRow[]) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExperienceRow | null>(null);
  const empty: Omit<ExperienceRow, "id" | "organizationId"> = { companyName: "", title: "", startDate: "", endDate: null, isCurrent: false, location: "", description: "" };
  const [form, setForm] = useState(empty);

  function openNew() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(e: ExperienceRow) {
    setEditing(e);
    setForm({ companyName: e.companyName, title: e.title, startDate: e.startDate.slice(0, 10), endDate: e.endDate ? e.endDate.slice(0, 10) : null, isCurrent: e.isCurrent, location: e.location ?? "", description: e.description ?? "" });
    setOpen(true);
  }
  async function save() {
    if (!form.companyName.trim() || !form.title.trim() || !form.startDate) {
      toast("Company, title and start date are required.", { kind: "err" });
      return;
    }
    const payload = { companyName: form.companyName, title: form.title, startDate: form.startDate, endDate: form.isCurrent ? null : form.endDate || null, isCurrent: form.isCurrent, location: form.location || null, description: form.description || null };
    try {
      if (editing) {
        const r = await api<{ experience: ExperienceRow }>(`/me/profile/experiences/${editing.id}`, { method: "PATCH", body: payload });
        onChange(experiences.map((x) => (x.id === editing.id ? r.experience : x)));
      } else {
        const r = await api<{ experience: ExperienceRow }>("/me/profile/experiences", { method: "POST", body: payload });
        onChange([...experiences, r.experience]);
      }
      setOpen(false);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/me/profile/experiences/${id}`, { method: "DELETE" });
      onChange(experiences.filter((x) => x.id !== id));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="card">
      <div className="ct">
        Experience{" "}
        <Button small icon="plus" onClick={openNew} data-testid="profile-editor-experience-add">
          Add
        </Button>
      </div>
      <div className="list">
        {experiences.map((e) => (
          <div className="li" key={e.id}>
            <div className="t">
              <b>
                {e.title} · {e.companyName}
              </b>
              <small>
                {e.startDate.slice(0, 10)} – {e.isCurrent ? "present" : e.endDate?.slice(0, 10) ?? ""}
              </small>
            </div>
            <div className="row">
              <button type="button" className="ib" aria-label={`Edit ${e.title}`} onClick={() => openEdit(e)} data-testid={`profile-editor-experience-edit-${e.id}`}>
                ✎
              </button>
              <button type="button" className="ib" aria-label={`Delete ${e.title}`} onClick={() => void remove(e.id)} data-testid={`profile-editor-experience-delete-${e.id}`}>
                ✕
              </button>
            </div>
          </div>
        ))}
        {!experiences.length ? <p className="sm dim">No experience added yet.</p> : null}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "Edit experience" : "Add experience"} footer={<Button kind="p" onClick={save} data-testid="profile-editor-experience-save">Save</Button>}>
        <div className="grid2">
          <Field label="Company" htmlFor="ex-company">
            <input id="ex-company" className="in" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} data-testid="profile-editor-experience-company" />
          </Field>
          <Field label="Title" htmlFor="ex-title">
            <input id="ex-title" className="in" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="profile-editor-experience-title" />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Start date" htmlFor="ex-start">
            <input id="ex-start" type="date" className="in" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} data-testid="profile-editor-experience-start" />
          </Field>
          <Field label="End date" htmlFor="ex-end">
            <input id="ex-end" type="date" className="in" disabled={form.isCurrent} value={form.endDate ?? ""} onChange={(e) => setForm({ ...form, endDate: e.target.value })} data-testid="profile-editor-experience-end" />
          </Field>
        </div>
        <label className="row sm" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={form.isCurrent} onChange={(e) => setForm({ ...form, isCurrent: e.target.checked })} data-testid="profile-editor-experience-current" />
          I currently work here
        </label>
        <Field label="Location" htmlFor="ex-loc">
          <input id="ex-loc" className="in" value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value })} data-testid="profile-editor-experience-location" />
        </Field>
        <Field label="Description" htmlFor="ex-desc">
          <textarea id="ex-desc" className="in" rows={3} value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="profile-editor-experience-description" />
        </Field>
      </Dialog>
    </div>
  );
}

/* ── Education ──────────────────────────────────────────────────────────── */
function EducationSection({ educations, onChange }: { educations: EducationRow[]; onChange: (v: EducationRow[]) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EducationRow | null>(null);
  const empty = { school: "", degree: "", field: "", startYear: "", endYear: "" };
  const [form, setForm] = useState(empty);

  function openNew() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(e: EducationRow) {
    setEditing(e);
    setForm({ school: e.school, degree: e.degree ?? "", field: e.field ?? "", startYear: e.startYear?.toString() ?? "", endYear: e.endYear?.toString() ?? "" });
    setOpen(true);
  }
  async function save() {
    if (!form.school.trim()) {
      toast("School is required.", { kind: "err" });
      return;
    }
    const payload = { school: form.school, degree: form.degree || null, field: form.field || null, startYear: form.startYear ? Number(form.startYear) : null, endYear: form.endYear ? Number(form.endYear) : null };
    try {
      if (editing) {
        const r = await api<{ education: EducationRow }>(`/me/profile/educations/${editing.id}`, { method: "PATCH", body: payload });
        onChange(educations.map((x) => (x.id === editing.id ? r.education : x)));
      } else {
        const r = await api<{ education: EducationRow }>("/me/profile/educations", { method: "POST", body: payload });
        onChange([...educations, r.education]);
      }
      setOpen(false);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/me/profile/educations/${id}`, { method: "DELETE" });
      onChange(educations.filter((x) => x.id !== id));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="card">
      <div className="ct">
        Education{" "}
        <Button small icon="plus" onClick={openNew} data-testid="profile-editor-education-add">
          Add
        </Button>
      </div>
      <div className="list">
        {educations.map((e) => (
          <div className="li" key={e.id}>
            <div className="t">
              <b>{e.school}</b>
              <small>
                {[e.degree, e.field].filter(Boolean).join(", ")} {e.startYear ? `· ${e.startYear}–${e.endYear ?? ""}` : ""}
              </small>
            </div>
            <div className="row">
              <button type="button" className="ib" aria-label={`Edit ${e.school}`} onClick={() => openEdit(e)} data-testid={`profile-editor-education-edit-${e.id}`}>
                ✎
              </button>
              <button type="button" className="ib" aria-label={`Delete ${e.school}`} onClick={() => void remove(e.id)} data-testid={`profile-editor-education-delete-${e.id}`}>
                ✕
              </button>
            </div>
          </div>
        ))}
        {!educations.length ? <p className="sm dim">No education added yet.</p> : null}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "Edit education" : "Add education"} footer={<Button kind="p" onClick={save} data-testid="profile-editor-education-save">Save</Button>}>
        <Field label="School" htmlFor="ed-school">
          <input id="ed-school" className="in" value={form.school} onChange={(e) => setForm({ ...form, school: e.target.value })} data-testid="profile-editor-education-school" />
        </Field>
        <div className="grid2">
          <Field label="Degree" htmlFor="ed-degree">
            <input id="ed-degree" className="in" value={form.degree} onChange={(e) => setForm({ ...form, degree: e.target.value })} data-testid="profile-editor-education-degree" />
          </Field>
          <Field label="Field of study" htmlFor="ed-field">
            <input id="ed-field" className="in" value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value })} data-testid="profile-editor-education-field" />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Start year" htmlFor="ed-start">
            <input id="ed-start" className="in" type="number" value={form.startYear} onChange={(e) => setForm({ ...form, startYear: e.target.value })} data-testid="profile-editor-education-start" />
          </Field>
          <Field label="End year" htmlFor="ed-end">
            <input id="ed-end" className="in" type="number" value={form.endYear} onChange={(e) => setForm({ ...form, endYear: e.target.value })} data-testid="profile-editor-education-end" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/* ── Services ───────────────────────────────────────────────────────────── */
function ServiceSection({ services, onChange }: { services: ServiceRow[]; onChange: (v: ServiceRow[]) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const empty = { name: "", description: "", priceFrom: "", priceNote: "" };
  const [form, setForm] = useState(empty);

  function openNew() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(s: ServiceRow) {
    setEditing(s);
    setForm({ name: s.name, description: s.description ?? "", priceFrom: s.priceFrom ?? "", priceNote: s.priceNote ?? "" });
    setOpen(true);
  }
  async function save() {
    if (!form.name.trim()) {
      toast("Name is required.", { kind: "err" });
      return;
    }
    const payload = { name: form.name, description: form.description || null, priceFrom: form.priceFrom ? Number(form.priceFrom) : null, priceNote: form.priceNote || null };
    try {
      if (editing) {
        const r = await api<{ service: ServiceRow }>(`/me/profile/services/${editing.id}`, { method: "PATCH", body: payload });
        onChange(services.map((x) => (x.id === editing.id ? r.service : x)));
      } else {
        const r = await api<{ service: ServiceRow }>("/me/profile/services", { method: "POST", body: payload });
        onChange([...services, r.service]);
      }
      setOpen(false);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/me/profile/services/${id}`, { method: "DELETE" });
      onChange(services.filter((x) => x.id !== id));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="card">
      <div className="ct">
        Services{" "}
        <Button small icon="plus" onClick={openNew} data-testid="profile-editor-service-add">
          Add
        </Button>
      </div>
      <div className="grid3">
        {services.map((s) => (
          <div key={s.id} className="card tight" style={{ background: "var(--bg-soft)" }}>
            <b>{s.name}</b>
            <small className="dim" style={{ display: "block" }}>
              {s.priceFrom ? `From $${s.priceFrom}` : ""} {s.priceNote}
            </small>
            <div className="row" style={{ marginTop: 6 }}>
              <Button small onClick={() => openEdit(s)} data-testid={`profile-editor-service-edit-${s.id}`}>
                Edit
              </Button>
              <Button small onClick={() => void remove(s.id)} data-testid={`profile-editor-service-delete-${s.id}`}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
      {!services.length ? <p className="sm dim">No services added yet.</p> : null}
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "Edit service" : "Add service"} footer={<Button kind="p" onClick={save} data-testid="profile-editor-service-save">Save</Button>}>
        <Field label="Name" htmlFor="sv-name">
          <input id="sv-name" className="in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="profile-editor-service-name" />
        </Field>
        <Field label="Description" htmlFor="sv-desc">
          <textarea id="sv-desc" className="in" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="profile-editor-service-description" />
        </Field>
        <div className="grid2">
          <Field label="Price from ($)" htmlFor="sv-price">
            <input id="sv-price" className="in" type="number" value={form.priceFrom} onChange={(e) => setForm({ ...form, priceFrom: e.target.value })} data-testid="profile-editor-service-price" />
          </Field>
          <Field label="Price note" htmlFor="sv-note">
            <input id="sv-note" className="in" value={form.priceNote} onChange={(e) => setForm({ ...form, priceNote: e.target.value })} data-testid="profile-editor-service-note" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/* ── Certifications ─────────────────────────────────────────────────────── */
function CertificationSection({ certifications, onChange }: { certifications: CertificationRow[]; onChange: (v: CertificationRow[]) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CertificationRow | null>(null);
  const empty = { name: "", issuer: "", issuedAt: "", expiresAt: "" };
  const [form, setForm] = useState(empty);

  function openNew() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(c: CertificationRow) {
    setEditing(c);
    setForm({ name: c.name, issuer: c.issuer ?? "", issuedAt: c.issuedAt?.slice(0, 10) ?? "", expiresAt: c.expiresAt?.slice(0, 10) ?? "" });
    setOpen(true);
  }
  async function save() {
    if (!form.name.trim()) {
      toast("Name is required.", { kind: "err" });
      return;
    }
    const payload = { name: form.name, issuer: form.issuer || null, issuedAt: form.issuedAt || null, expiresAt: form.expiresAt || null };
    try {
      if (editing) {
        const r = await api<{ certification: CertificationRow }>(`/me/profile/certifications/${editing.id}`, { method: "PATCH", body: payload });
        onChange(certifications.map((x) => (x.id === editing.id ? r.certification : x)));
      } else {
        const r = await api<{ certification: CertificationRow }>("/me/profile/certifications", { method: "POST", body: payload });
        onChange([...certifications, r.certification]);
      }
      setOpen(false);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/me/profile/certifications/${id}`, { method: "DELETE" });
      onChange(certifications.filter((x) => x.id !== id));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="card">
      <div className="ct">
        Certifications{" "}
        <Button small icon="plus" onClick={openNew} data-testid="profile-editor-certification-add">
          Add
        </Button>
      </div>
      <div className="list sm">
        {certifications.map((c) => (
          <div className="li" key={c.id}>
            <div className="t">
              <b>{c.name}</b>
              <small>{c.issuer}</small>
            </div>
            <div className="row">
              <button type="button" className="ib" aria-label={`Edit ${c.name}`} onClick={() => openEdit(c)} data-testid={`profile-editor-certification-edit-${c.id}`}>
                ✎
              </button>
              <button type="button" className="ib" aria-label={`Delete ${c.name}`} onClick={() => void remove(c.id)} data-testid={`profile-editor-certification-delete-${c.id}`}>
                ✕
              </button>
            </div>
          </div>
        ))}
        {!certifications.length ? <p className="sm dim">No certifications added yet.</p> : null}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "Edit certification" : "Add certification"} footer={<Button kind="p" onClick={save} data-testid="profile-editor-certification-save">Save</Button>}>
        <Field label="Name" htmlFor="ct-name">
          <input id="ct-name" className="in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="profile-editor-certification-name" />
        </Field>
        <Field label="Issuer" htmlFor="ct-issuer">
          <input id="ct-issuer" className="in" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} data-testid="profile-editor-certification-issuer" />
        </Field>
        <div className="grid2">
          <Field label="Issued" htmlFor="ct-issued">
            <input id="ct-issued" type="date" className="in" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} data-testid="profile-editor-certification-issued" />
          </Field>
          <Field label="Expires" htmlFor="ct-expires">
            <input id="ct-expires" type="date" className="in" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} data-testid="profile-editor-certification-expires" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/* ── Portfolio ──────────────────────────────────────────────────────────── */
function PortfolioSection({ portfolio, onChange }: { portfolio: PortfolioRow[]; onChange: (v: PortfolioRow[]) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PortfolioRow | null>(null);
  const empty = { title: "", description: "", url: "" };
  const [form, setForm] = useState(empty);

  function openNew() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(p: PortfolioRow) {
    setEditing(p);
    setForm({ title: p.title, description: p.description ?? "", url: p.url ?? "" });
    setOpen(true);
  }
  async function save() {
    if (!form.title.trim()) {
      toast("Title is required.", { kind: "err" });
      return;
    }
    const payload = { title: form.title, description: form.description || null, url: form.url || null };
    try {
      if (editing) {
        const r = await api<{ item: PortfolioRow }>(`/me/profile/portfolio/${editing.id}`, { method: "PATCH", body: payload });
        onChange(portfolio.map((x) => (x.id === editing.id ? r.item : x)));
      } else {
        const r = await api<{ item: PortfolioRow }>("/me/profile/portfolio", { method: "POST", body: payload });
        onChange([...portfolio, r.item]);
      }
      setOpen(false);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/me/profile/portfolio/${id}`, { method: "DELETE" });
      onChange(portfolio.filter((x) => x.id !== id));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="card">
      <div className="ct">
        Portfolio{" "}
        <Button small icon="plus" onClick={openNew} data-testid="profile-editor-portfolio-add">
          Add
        </Button>
      </div>
      <div className="grid3">
        {portfolio.map((p) => (
          <div key={p.id} className="card tight" style={{ background: "var(--bg-soft)" }}>
            <b className="sm">{p.title}</b>
            {p.url ? (
              <small className="dim" style={{ display: "block" }}>
                {p.url}
              </small>
            ) : null}
            <div className="row" style={{ marginTop: 6 }}>
              <Button small onClick={() => openEdit(p)} data-testid={`profile-editor-portfolio-edit-${p.id}`}>
                Edit
              </Button>
              <Button small onClick={() => void remove(p.id)} data-testid={`profile-editor-portfolio-delete-${p.id}`}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
      {!portfolio.length ? <p className="sm dim">Nothing added yet.</p> : null}
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "Edit portfolio item" : "Add portfolio item"} footer={<Button kind="p" onClick={save} data-testid="profile-editor-portfolio-save">Save</Button>}>
        <Field label="Title" htmlFor="pt-title">
          <input id="pt-title" className="in" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="profile-editor-portfolio-title" />
        </Field>
        <Field label="Description" htmlFor="pt-desc">
          <textarea id="pt-desc" className="in" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="profile-editor-portfolio-description" />
        </Field>
        <Field label="Link" htmlFor="pt-url">
          <input id="pt-url" className="in" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" data-testid="profile-editor-portfolio-url" />
        </Field>
      </Dialog>
    </div>
  );
}
