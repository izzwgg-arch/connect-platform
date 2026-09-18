"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Chip, Field, useToast } from "@/components/ui";
import "@/components/opportunities/opportunities.css";

type OppField = { key: string; label: string; type: "text" | "number" | "money" | "date" | "select" | "multiselect" | "boolean"; required?: boolean; options?: string[] };
type OppType = { id: string; slug: string; name: string; description: string | null; fieldSchema: OppField[]; count: number };

function DynamicField({ f, value, onChange }: { f: OppField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `opp-field-${f.key}`;
  if (f.type === "boolean") {
    return (
      <Field label={f.label} htmlFor={id}>
        <select id={id} className="in" value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "yes")} data-testid={`opportunities-new-field-${f.key}`}>
          <option value="">Choose…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </Field>
    );
  }
  if (f.type === "select") {
    return (
      <Field label={f.label} htmlFor={id}>
        <select id={id} className="in" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} data-testid={`opportunities-new-field-${f.key}`}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (f.type === "multiselect") {
    const values = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Field label={f.label} htmlFor={id}>
        <div className="opp-multiselect" id={id}>
          {(f.options ?? []).map((o) => (
            <Chip key={o} kind={values.includes(o) ? "sel" : ""} onClick={() => onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o])} testId={`opportunities-new-field-${f.key}-${o}`}>
              {o}
            </Chip>
          ))}
        </div>
      </Field>
    );
  }
  if (f.type === "date") {
    return (
      <Field label={f.label} htmlFor={id}>
        <input id={id} type="date" className="in" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} data-testid={`opportunities-new-field-${f.key}`} />
      </Field>
    );
  }
  if (f.type === "number" || f.type === "money") {
    return (
      <Field label={f.label} htmlFor={id}>
        <input
          id={id}
          type="number"
          step={f.type === "money" ? "0.01" : "1"}
          min={0}
          className="in"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          data-testid={`opportunities-new-field-${f.key}`}
        />
      </Field>
    );
  }
  return (
    <Field label={f.label} htmlFor={id}>
      <input id={id} className="in" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} maxLength={200} data-testid={`opportunities-new-field-${f.key}`} />
    </Field>
  );
}

function NewOpportunityForm() {
  const router = useRouter();
  const toast = useToast();
  const { me } = useAuth();
  const [types, setTypes] = useState<OppType[]>([]);
  const [typeSlug, setTypeSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ types: OppType[] }>("/opportunities/types")
      .then((r) => {
        setTypes(r.types);
        if (r.types.length) setTypeSlug(r.types[0].slug);
      })
      .catch(() => setTypes([]));
  }, []);

  const activeType = useMemo(() => types.find((t) => t.slug === typeSlug) ?? null, [types, typeSlug]);

  function setField(key: string, v: unknown) {
    setFields((f) => ({ ...f, [key]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!typeSlug) {
      setError("Choose a type.");
      return;
    }
    if (title.trim().length < 3) {
      setError("Give it a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ opportunity: { id: string } }>("/opportunities", {
        method: "POST",
        body: {
          typeSlug,
          title: title.trim(),
          description: description.trim(),
          location: location.trim() || undefined,
          organizationId: organizationId || undefined,
          fields,
        },
      });
      toast("Opportunity posted.");
      router.push(`/opportunities/${created.opportunity.id}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't post that opportunity.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
      <form className="card" onSubmit={submit}>
        <div className="ct">Post an opportunity</div>

        <Field label="Type" htmlFor="opp-type">
          <select
            id="opp-type"
            className="in"
            value={typeSlug}
            onChange={(e) => {
              setTypeSlug(e.target.value);
              setFields({});
            }}
            data-testid="opportunities-new-type"
          >
            {types.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
          {activeType?.description ? <span className="help">{activeType.description}</span> : null}
        </Field>

        <Field label="Posting as" htmlFor="opp-org">
          <select id="opp-org" className="in" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} data-testid="opportunities-new-org">
            <option value="">Just me</option>
            {(me?.memberships ?? []).map((m) => (
              <option key={m.organization.id} value={m.organization.id}>
                {m.organization.displayName}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Title" htmlFor="opp-title">
          <input id="opp-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required data-testid="opportunities-new-title" />
        </Field>
        <Field label="Description" htmlFor="opp-desc">
          <textarea id="opp-desc" className="in" style={{ minHeight: 100 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} data-testid="opportunities-new-description" />
        </Field>
        <Field label="Location" htmlFor="opp-loc">
          <input id="opp-loc" className="in" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={160} data-testid="opportunities-new-location" />
        </Field>

        {activeType ? (
          <div className="opp-field-grid">
            {activeType.fieldSchema.map((f) => (
              <DynamicField key={f.key} f={f} value={fields[f.key]} onChange={(v) => setField(f.key, v)} />
            ))}
          </div>
        ) : null}

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row" style={{ marginTop: 10 }}>
          <Button kind="p" type="submit" loading={busy} data-testid="opportunities-new-submit">
            Post opportunity
          </Button>
          <Button kind="g" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewOpportunityPage() {
  return (
    <RequireAuth>
      <AppShell title="Post an opportunity">
        <NewOpportunityForm />
      </AppShell>
    </RequireAuth>
  );
}
