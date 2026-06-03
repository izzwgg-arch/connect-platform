"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, FileSignature, Loader2 } from "lucide-react";
import { ApiError, getPortalApiBaseUrl } from "../../../../services/apiClient";

type PublicField = {
  id: string;
  fieldType: "TEXT" | "DATE" | "CHECKBOX" | "SIGNATURE" | "INITIALS";
  label: string;
  required: boolean;
  pageNumber: number;
};

type PublicForm = {
  request: { id: string; status: string; expiresAt: string | null; completedAt: string | null };
  contact: { displayName: string | null; company: string | null };
  template: { id: string; name: string; description: string | null; category: string | null; pageCount: number | null };
  fields: PublicField[];
  submission: { submittedAt: string } | null;
};

async function publicJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${getPortalApiBaseUrl()}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(String(json?.error || `Request failed (${res.status})`), res.status, json);
  return json as T;
}

export default function PublicFormSigningPage() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await publicJson<PublicForm>(`/public/forms/${encodeURIComponent(token)}`);
      setForm(data);
      setComplete(data.request.status === "COMPLETED" || Boolean(data.submission));
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.message === "expired") setError("This form link has expired.");
      else if (apiError.message === "revoked") setError("This form link has been revoked.");
      else setError("This form link is invalid or no longer available.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const requiredMissing = useMemo(() => {
    const missing: Record<string, string> = {};
    for (const field of form?.fields || []) {
      if (!field.required) continue;
      if (field.fieldType === "CHECKBOX") {
        if (values[field.id] !== true) missing[field.id] = "Required";
      } else if (!String(values[field.id] ?? "").trim()) {
        missing[field.id] = "Required";
      }
    }
    return missing;
  }, [form?.fields, values]);

  const submit = async () => {
    if (!form) return;
    const missing = requiredMissing;
    if (Object.keys(missing).length) {
      setFieldErrors(missing);
      return;
    }
    setSubmitting(true);
    setFieldErrors({});
    setError(null);
    try {
      await publicJson(`/public/forms/${encodeURIComponent(token)}/submit`, { submittedData: values });
      setComplete(true);
    } catch (err) {
      const apiError = err as ApiError;
      const body = apiError.body as { fields?: Record<string, string>; error?: string } | null;
      if (body?.fields) setFieldErrors(body.fields);
      setError(body?.error === "validation_failed" ? "Please complete all required fields." : "Unable to submit this form.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-400/15 text-cyan-200">
              <FileSignature className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">Connect CRM</p>
              <h1 className="text-2xl font-semibold">{form?.template.name || "Secure Form"}</h1>
            </div>
          </div>
          {form?.template.description ? <p className="mt-3 text-sm text-slate-300">{form.template.description}</p> : null}
        </header>

        {loading ? (
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-10 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-200" />
            <p className="mt-3 text-sm text-slate-300">Loading secure form…</p>
          </div>
        ) : error && !form ? (
          <div className="rounded-3xl border border-red-400/20 bg-red-500/10 p-8 text-center text-red-100">{error}</div>
        ) : complete ? (
          <div className="rounded-3xl border border-emerald-400/20 bg-emerald-500/10 p-10 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-200" />
            <h2 className="mt-4 text-xl font-semibold">Form submitted</h2>
            <p className="mt-2 text-sm text-emerald-100/80">Thank you. Your completed form has been securely saved back to the CRM.</p>
          </div>
        ) : form ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
            <section className="min-h-[520px] overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04]">
              <iframe
                title="PDF form preview"
                src={`${getPortalApiBaseUrl()}/public/forms/${encodeURIComponent(token)}/pdf`}
                className="h-[70vh] min-h-[520px] w-full bg-white"
              />
            </section>
            <aside className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
              <div className="mb-4">
                <h2 className="text-lg font-semibold">Complete fields</h2>
                <p className="mt-1 text-sm text-slate-300">Required fields are marked. Signatures and initials are captured as typed consent in Phase 1.</p>
              </div>
              <div className="space-y-4">
                {form.fields.map((field) => (
                  <label key={field.id} className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-200">
                      {field.label} {field.required ? <span className="text-red-300">*</span> : null}
                    </span>
                    {field.fieldType === "CHECKBOX" ? (
                      <input
                        type="checkbox"
                        checked={values[field.id] === true}
                        onChange={(event) => setValues((prev) => ({ ...prev, [field.id]: event.target.checked }))}
                      />
                    ) : (
                      <input
                        type={field.fieldType === "DATE" ? "date" : "text"}
                        value={String(values[field.id] ?? "")}
                        onChange={(event) => setValues((prev) => ({ ...prev, [field.id]: event.target.value }))}
                        placeholder={field.fieldType === "SIGNATURE" ? "Type full legal signature" : field.fieldType === "INITIALS" ? "Type initials" : ""}
                        className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300"
                      />
                    )}
                    {fieldErrors[field.id] ? <span className="mt-1 block text-xs text-red-300">{fieldErrors[field.id]}</span> : null}
                  </label>
                ))}
              </div>
              {error ? <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div> : null}
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="mt-5 w-full rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-60"
              >
                {submitting ? "Submitting…" : "Submit completed form"}
              </button>
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}
