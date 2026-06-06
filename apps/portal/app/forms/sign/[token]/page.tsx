"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  CheckCircle2,
  ExternalLink,
  FileSignature,
  Loader2,
  PenLine,
  RotateCcw,
  Shield,
} from "lucide-react";
import { ApiError, getPortalApiBaseUrl } from "../../../../services/apiClient";

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldType = "TEXT" | "DATE" | "CHECKBOX" | "SIGNATURE" | "INITIALS";

type PublicField = {
  id: string;
  fieldType: FieldType;
  label: string;
  autoFillToken?: string | null;
  /** Server-resolved value for the autoFillToken — pre-populates the field. */
  defaultValue?: string;
  required: boolean;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PublicForm = {
  tenantName: string | null;
  request: { id: string; status: string; expiresAt: string | null; completedAt: string | null };
  contact: {
    displayName: string | null;
    company: string | null;
    primaryPhone: string | null;
    primaryEmail: string | null;
  };
  template: {
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    pageCount: number | null;
  };
  fields: PublicField[];
  submission: { submittedAt: string } | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Demo / preview data (token === "demo") ────────────────────────────────

const DEMO_FORM: PublicForm = {
  tenantName: "Ribbit Capital",
  request: {
    id: "demo",
    status: "SENT",
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    completedAt: null,
  },
  contact: {
    displayName: "Jordan Rivera",
    company: "Connect Demo Co",
    primaryPhone: "(555) 010-9881",
    primaryEmail: "demo.user@example.com",
  },
  template: {
    id: "demo",
    name: "Client Agreement & Authorization",
    description: "Please review and sign this agreement before we proceed with your account setup.",
    category: "Agreements",
    pageCount: 2,
  },
  fields: [
    { id: "f1", fieldType: "TEXT",      label: "Full legal name",    autoFillToken: "contact.fullName",  defaultValue: "Jordan Rivera",          required: true,  pageNumber: 1, x: 60, y: 120, width: 180, height: 18 },
    { id: "f2", fieldType: "TEXT",      label: "Business / DBA name", autoFillToken: "business.dba",     defaultValue: "Connect Demo Services",  required: false, pageNumber: 1, x: 60, y: 150, width: 180, height: 18 },
    { id: "f3", fieldType: "TEXT",      label: "Entity type",         autoFillToken: "business.entityType", defaultValue: "LLC",                required: false, pageNumber: 1, x: 60, y: 180, width: 120, height: 18 },
    { id: "f4", fieldType: "TEXT",      label: "Email address",       autoFillToken: "contact.email",    defaultValue: "demo.user@example.com",  required: true,  pageNumber: 1, x: 60, y: 210, width: 180, height: 18 },
    { id: "f5", fieldType: "TEXT",      label: "Phone number",        autoFillToken: "contact.phone",    defaultValue: "(555) 010-9881",         required: false, pageNumber: 1, x: 60, y: 240, width: 140, height: 18 },
    { id: "f6", fieldType: "TEXT",      label: "EIN / Tax ID",        autoFillToken: "business.ein",     defaultValue: "",                       required: false, pageNumber: 1, x: 60, y: 270, width: 140, height: 18 },
    { id: "f7", fieldType: "DATE",      label: "Effective date",      autoFillToken: "form.date",        defaultValue: new Date().toISOString().slice(0, 10), required: false, pageNumber: 1, x: 60, y: 300, width: 120, height: 18 },
    { id: "f8", fieldType: "CHECKBOX",  label: "I have read and agree to the terms and conditions", required: true, pageNumber: 2, x: 60, y: 120, width: 14, height: 14 },
    { id: "f9", fieldType: "INITIALS",  label: "Initials — page 1",   required: true, pageNumber: 1, x: 60, y: 330, width: 80, height: 22 },
    { id: "f10", fieldType: "SIGNATURE", label: "Authorized signature", required: true, pageNumber: 2, x: 60, y: 160, width: 180, height: 32 },
  ],
  submission: null,
};

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
}

function fmtPdfDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[2]}/${match[3]}/${match[1]}`;
  return raw;
}

function isImageSignature(value: unknown) {
  return String(value ?? "").startsWith("data:image/");
}

type PageSize = { width: number; height: number; scale: number };

function displayRectForField(field: PublicField, pageFields: PublicField[]) {
  const sameRow = pageFields
    .filter((other) => other.id !== field.id && Math.abs(other.y - field.y) <= 2 && other.x > field.x && other.x < field.x + field.width)
    .sort((a, b) => a.x - b.x);
  if (sameRow[0]) {
    return { ...field, width: Math.max(1, sameRow[0].x - field.x) };
  }

  const precedingOverlap = pageFields
    .filter((other) => other.id !== field.id && Math.abs(other.y - field.y) <= 2 && other.x < field.x && field.x < other.x + other.width)
    .sort((a, b) => a.x - b.x);
  if (precedingOverlap.length > 0) {
    const rowStart = precedingOverlap[0];
    const rowEnd = rowStart.x + rowStart.width;
    return { ...field, width: Math.max(1, rowEnd - field.x) };
  }

  return field;
}

function PdfPageCanvas({
  pdfUrl,
  pageNumber,
  onSize,
  onError,
}: {
  pdfUrl: string;
  pageNumber: number;
  onSize: (s: PageSize) => void;
  onError: (msg: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onSizeRef = useRef(onSize);
  const onErrorRef = useRef(onError);

  useEffect(() => { onSizeRef.current = onSize; });
  useEffect(() => { onErrorRef.current = onError; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfjsLib = await import("pdfjs-dist/build/pdf.mjs" as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pdfjsLib as any).GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loadingTask = (pdfjsLib as any).getDocument({ url: pdfUrl });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const containerWidth = canvasRef.current?.parentElement?.clientWidth || 700;
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min((containerWidth - 2) / vp0.width, 2.2);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext("2d")!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.render({ canvasContext: ctx as any, viewport }).promise;
        if (!cancelled) onSizeRef.current({ width: viewport.width, height: viewport.height, scale });
      } catch (err) {
        if (!cancelled) onErrorRef.current(err instanceof Error ? err.message : "Unable to render PDF.");
      }
    })();
    return () => { cancelled = true; };
  }, [pdfUrl, pageNumber]);

  return <canvas ref={canvasRef} className="block bg-white" />;
}

function PdfFieldOverlay({
  field,
  value,
  scale,
  pageFields,
}: {
  field: PublicField;
  value: unknown;
  scale: number;
  pageFields: PublicField[];
}) {
  const rect = displayRectForField(field, pageFields);
  const text = field.fieldType === "DATE" ? fmtPdfDate(value) : String(value ?? "").trim();
  const hasValue = field.fieldType === "CHECKBOX" ? value === true : Boolean(text);
  const isSignature = field.fieldType === "SIGNATURE" || field.fieldType === "INITIALS";
  const isCenteredCell = field.fieldType === "DATE" || /^(city|state|zip(?: code)?)$/i.test(field.label.trim());
  const scaledHeight = rect.height * scale;
  const fontSize = isSignature
    ? Math.max(10, Math.min(scaledHeight * 1.55, 22))
    : Math.max(7, Math.min(scaledHeight * 0.9, 10));

  return (
    <div
      className="absolute flex items-center overflow-hidden"
      style={{
        left: rect.x * scale,
        top: rect.y * scale,
        width: rect.width * scale,
        height: scaledHeight,
        justifyContent: isCenteredCell ? "center" : "flex-start",
        overflow: isSignature ? "visible" : "hidden",
        pointerEvents: "none",
      }}
    >
      {field.fieldType === "CHECKBOX" ? (
        hasValue ? <span className="text-sm font-bold leading-none text-slate-950">✓</span> : null
      ) : isImageSignature(value) ? (
        <img src={String(value)} alt="" className="h-full w-full object-contain object-left" />
      ) : hasValue ? (
        <span
          className="block truncate text-slate-950"
          style={{
            fontFamily: isSignature ? "Brush Script MT, Segoe Script, Lucida Handwriting, cursive" : "Arial, sans-serif",
            fontSize,
            lineHeight: 1,
            maxWidth: rect.width * scale,
            transform: isSignature ? "translateY(1px)" : undefined,
          }}
        >
          {text}
        </span>
      ) : field.required ? (
        <span className="block h-full rounded-sm border border-dashed border-amber-300/70 bg-amber-100/20" />
      ) : null}
    </div>
  );
}

// ─── Signature Canvas ─────────────────────────────────────────────────────────

function SignatureCanvas({
  value,
  onChange,
  small = false,
  error,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  small?: boolean;
  error?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const [hasStrokes, setHasStrokes] = useState(isImageSignature(value));

  // Restore saved image signatures; typed signatures render as text on the PDF overlay.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!isImageSignature(value)) {
      setHasStrokes(false);
      return;
    }
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      setHasStrokes(true);
    };
    img.src = value;
  }, [value]);

  function getPoint(e: React.MouseEvent | React.TouchEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      const t = e.touches[0];
      return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    drawing.current = true;
    lastPt.current = getPoint(e);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(lastPt.current.x, lastPt.current.y);
    }
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    const pt = getPoint(e);
    ctx.lineWidth = small ? 1.5 : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1e293b";
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastPt.current = pt;
    setHasStrokes(true);
  }

  function stopDraw() {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (canvas) onChange(canvas.toDataURL("image/png"));
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStrokes(false);
    onChange("");
  }

  const h = small ? 60 : 110;
  const w = small ? 200 : 420;

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`relative overflow-hidden rounded-xl border-2 bg-white ${
          error ? "border-red-400" : hasStrokes ? "border-indigo-400" : "border-slate-200"
        }`}
        style={{ height: h, touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          width={w}
          height={h}
          className="h-full w-full cursor-crosshair"
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={stopDraw}
          onMouseLeave={stopDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={stopDraw}
        />
        {!hasStrokes && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-slate-300">
            <PenLine className="h-4 w-4" />
            <span className="text-sm">{small ? "Initials" : "Sign here"}</span>
          </div>
        )}
        {hasStrokes && (
          <button
            type="button"
            onClick={clear}
            className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-lg bg-white/90 px-2 py-1 text-xs font-medium text-slate-500 shadow hover:bg-white hover:text-red-500"
          >
            <RotateCcw className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>
      {error ? <p className="text-xs font-medium text-red-500">{error}</p> : null}
    </div>
  );
}

// ─── Individual field ─────────────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
  error,
  prefilled,
}: {
  field: PublicField;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  /** Whether this field was auto-filled from the contact profile */
  prefilled?: boolean;
}) {
  const base =
    "w-full rounded-xl border bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

  if (field.fieldType === "CHECKBOX") {
    return (
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 hover:border-indigo-300">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-indigo-600"
        />
        <span className="text-sm text-slate-700">I confirm and agree</span>
        {error ? <span className="ml-auto text-xs text-red-500">{error}</span> : null}
      </label>
    );
  }

  if (field.fieldType === "SIGNATURE") {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Type or draw your signature
        </p>
        <input
          value={isImageSignature(value) ? "" : String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your signature"
          className="mb-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-2xl text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          style={{ fontFamily: "Brush Script MT, Segoe Script, Lucida Handwriting, cursive" }}
        />
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Or draw below
        </p>
        <SignatureCanvas
          value={String(value ?? "")}
          onChange={onChange}
          error={error}
        />
        <p className="mt-2 text-[11px] text-slate-400">
          By drawing above you are providing your electronic signature.
        </p>
      </div>
    );
  }

  if (field.fieldType === "INITIALS") {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Type or draw your initials
        </p>
        <input
          value={isImageSignature(value) ? "" : String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type initials"
          className="mb-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xl text-slate-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          style={{ fontFamily: "Brush Script MT, Segoe Script, Lucida Handwriting, cursive" }}
        />
        <SignatureCanvas
          value={String(value ?? "")}
          onChange={onChange}
          small
          error={error}
        />
      </div>
    );
  }

  if (field.fieldType === "DATE") {
    return (
      <div className="relative">
        <input
          type="date"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={`${base} ${error ? "border-red-400" : prefilled ? "border-indigo-200 bg-indigo-50/30" : "border-slate-200"}`}
        />
        {prefilled ? (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-600">
            pre-filled
          </span>
        ) : null}
        {error ? <p className="mt-1 text-xs font-medium text-red-500">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        className={`${base} pr-20 ${error ? "border-red-400" : prefilled ? "border-indigo-200 bg-indigo-50/30" : "border-slate-200"}`}
      />
      {prefilled && String(value ?? "") ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-600">
          pre-filled
        </span>
      ) : null}
      {error ? <p className="mt-1 text-xs font-medium text-red-500">{error}</p> : null}
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepBar({ step }: { step: 1 | 2 | 3 }) {
  const steps = ["Review document", "Complete & sign", "Submitted"];
  return (
    <div className="flex items-center gap-0">
      {steps.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <div key={n} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                  done
                    ? "bg-indigo-600 text-white"
                    : active
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200"
                    : "bg-slate-100 text-slate-400"
                }`}
              >
                {done ? "✓" : n}
              </div>
              <span
                className={`hidden text-[11px] font-medium sm:block ${
                  active ? "text-indigo-700" : done ? "text-indigo-400" : "text-slate-400"
                }`}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`mx-2 mb-4 h-px w-12 sm:w-20 ${done ? "bg-indigo-400" : "bg-slate-200"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PublicFormSigningPage() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [step, setStep] = useState<1 | 2 | 3>(2);

  const pdfUrl = `${getPortalApiBaseUrl()}/public/forms/${encodeURIComponent(token ?? "")}/pdf`;

  const isDemo = token === "demo";

  // The global CRM shell sets overflow:hidden on html+body. Override it for
  // this public page so the signing flow can scroll normally.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "auto";
    body.style.overflow = "auto";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data: PublicForm = isDemo
        ? DEMO_FORM
        : await publicJson<PublicForm>(`/public/forms/${encodeURIComponent(token)}`);
      setForm(data);
      if (data.request.status === "COMPLETED" || Boolean(data.submission)) {
        setStep(3);
      } else {
        setStep(2);
      }
      // Pre-fill fields using server-resolved defaultValue (from autoFillToken),
      // falling back to label-keyword matching for any field without a token.
      if (data.fields.length) {
        const { displayName, company, primaryPhone, primaryEmail } = data.contact ?? {};
        const prefill: Record<string, unknown> = {};
        for (const field of data.fields) {
          if (field.fieldType === "SIGNATURE" || field.fieldType === "INITIALS" || field.fieldType === "CHECKBOX") continue;
          // 1️⃣ Token-resolved default from API
          if (field.defaultValue !== undefined && field.defaultValue !== "") {
            prefill[field.id] = field.defaultValue;
            continue;
          }
          // 2️⃣ Fuzzy fallback for fields with no token
          const lbl = field.label.toLowerCase();
          if (displayName && (lbl.includes("name") || lbl.includes("full name") || lbl.includes("client name"))) {
            prefill[field.id] = displayName;
          } else if (company && (lbl.includes("company") || lbl.includes("business") || lbl.includes("organization"))) {
            prefill[field.id] = company;
          } else if (primaryEmail && lbl.includes("email")) {
            prefill[field.id] = primaryEmail;
          } else if (primaryPhone && (lbl.includes("phone") || lbl.includes("mobile") || lbl.includes("cell"))) {
            prefill[field.id] = primaryPhone;
          }
        }
        if (Object.keys(prefill).length) setValues(prefill);
      }
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
      const firstId = form.fields.find((f) => missing[f.id])?.id;
      if (firstId) {
        document.getElementById(`field-${firstId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    setSubmitting(true);
    setFieldErrors({});
    setError(null);
    try {
      if (!isDemo) {
        await publicJson(`/public/forms/${encodeURIComponent(token)}/submit`, { submittedData: values });
      } else {
        // Demo mode — simulate a short network delay then show success
        await new Promise((r) => setTimeout(r, 900));
      }
      setStep(3);
    } catch (err) {
      const apiError = err as ApiError;
      const body = apiError.body as { fields?: Record<string, string>; error?: string } | null;
      if (body?.fields) setFieldErrors(body.fields);
      setError(body?.error === "validation_failed" ? "Please complete all required fields." : "Unable to submit this form. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const completedCount = useMemo(() => {
    if (!form) return 0;
    return form.fields.filter((f) => {
      if (f.fieldType === "CHECKBOX") return values[f.id] === true;
      return String(values[f.id] ?? "").trim().length > 0;
    }).length;
  }, [form, values]);

  const totalRequired = useMemo(() => form?.fields.filter((f) => f.required).length ?? 0, [form]);
  const renderedPageCount = useMemo(() => {
    if (!form) return 1;
    return Math.max(
      form.template.pageCount ?? 1,
      ...form.fields.map((field) => field.pageNumber || 1),
    );
  }, [form]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50/30 to-slate-100 px-4 pb-12 pt-6">
      <div className="mx-auto max-w-6xl">

        {/* Demo banner */}
        {isDemo ? (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700">
            <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-800">Preview</span>
            This is a demo — form submission will not be saved
          </div>
        ) : null}

        {/* Header */}
        <style jsx global>{`
          @media print {
            body * {
              visibility: hidden !important;
            }
            .public-form-print-document,
            .public-form-print-document * {
              visibility: visible !important;
            }
            .public-form-print-document {
              position: absolute !important;
              left: 0 !important;
              top: 0 !important;
              width: 100% !important;
              border: 0 !important;
              box-shadow: none !important;
            }
            .public-form-print-scroll {
              max-height: none !important;
              overflow: visible !important;
              padding: 0 !important;
              background: white !important;
            }
            .public-form-pdf-actions {
              display: none !important;
            }
          }
        `}</style>

        <header className="mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-200">
                <FileSignature className="h-6 w-6 text-white" />
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-indigo-500">
                  {form?.tenantName ?? "Secure Document Signing"}
                </p>
                <h1 className="text-xl font-bold text-slate-900">{form?.template.name || "Document"}</h1>
                {form?.contact?.displayName ? (
                  <p className="mt-0.5 text-sm text-slate-500">
                    For <span className="font-semibold text-slate-700">{form.contact.displayName}</span>
                    {form.contact.company ? <span className="text-slate-400"> · {form.contact.company}</span> : null}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
              <Shield className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-semibold text-emerald-700">SSL Encrypted · Tamper-evident</span>
            </div>
          </div>

          {step < 3 && !loading && form ? (
            <div className="mt-3 flex flex-wrap items-center justify-end gap-4">
              {form.request.expiresAt ? (
                <p className="text-xs text-slate-400">Expires {fmtDate(form.request.expiresAt)}</p>
              ) : null}
            </div>
          ) : null}
        </header>

        {/* Body */}
        {loading ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-slate-200 bg-white p-16 shadow-sm">
            <Loader2 className="h-9 w-9 animate-spin text-indigo-400" />
            <p className="text-sm text-slate-500">Loading secure form…</p>
          </div>
        ) : error && !form ? (
          <div className="rounded-3xl border border-red-200 bg-red-50 p-10 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
              <FileSignature className="h-7 w-7 text-red-400" />
            </div>
            <h2 className="text-lg font-semibold text-red-800">Unable to load form</h2>
            <p className="mt-2 text-sm text-red-600">{error}</p>
          </div>
        ) : step === 3 ? (
          // ── Submitted ──────────────────────────────────────────────────────
          <div className="rounded-3xl border border-emerald-200 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100">
              <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            </div>
            <h2 className="text-2xl font-bold text-slate-900">All done — thank you!</h2>
            <p className="mx-auto mt-3 max-w-md text-sm text-slate-500">
              Your completed form has been securely submitted and saved. The company will be notified and may follow up with you shortly.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{form?.tenantName ?? "Document"}</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-700">{form?.template.name}</p>
              </div>
              {form?.contact?.displayName ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Signed by</p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-700">{form.contact.displayName}</p>
                </div>
              ) : null}
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Submitted</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-700">
                  {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date())}
                </p>
              </div>
            </div>
          </div>
        ) : form ? (
          // ── Step 1: Review / Step 2: Complete & Sign ───────────────────────
          <div className="grid items-start gap-5 lg:grid-cols-[1fr_420px]">

            {/* Left — PDF viewer */}
            <div className="public-form-print-document self-start overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-700">
                  {form.template.name}
                  {form.template.pageCount ? (
                    <span className="ml-2 text-xs font-normal text-slate-400">· {form.template.pageCount} {form.template.pageCount === 1 ? "page" : "pages"}</span>
                  ) : null}
                </p>
                {!isDemo ? (
                  <div className="public-form-pdf-actions flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                    >
                      Print
                    </button>
                    <a
                      href={pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Original PDF
                    </a>
                  </div>
                ) : (
                  <span className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-600">
                    Demo — mock document
                  </span>
                )}
              </div>
              {isDemo ? (
                <div className="flex h-[72vh] min-h-[500px] w-full flex-col items-center justify-center gap-6 bg-slate-50 px-8">
                  {/* Simulated document pages */}
                  <div className="w-full max-w-md space-y-4">
                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                      <div className="mb-4 flex items-center justify-between">
                        <div className="h-2 w-2/3 rounded-full bg-slate-200" />
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Page 1 of 2</span>
                      </div>
                      <div className="space-y-2">
                        <div className="h-2 w-full rounded-full bg-slate-100" />
                        <div className="h-2 w-5/6 rounded-full bg-slate-100" />
                        <div className="h-2 w-full rounded-full bg-slate-100" />
                        <div className="h-2 w-4/5 rounded-full bg-slate-100" />
                        <div className="mt-4 h-2 w-full rounded-full bg-slate-100" />
                        <div className="h-2 w-3/4 rounded-full bg-slate-100" />
                        <div className="h-2 w-full rounded-full bg-slate-100" />
                      </div>
                      <div className="mt-5 rounded-xl border border-dashed border-indigo-200 bg-indigo-50/50 px-4 py-3">
                        <p className="text-xs font-medium text-indigo-500">§ 1. Authorization</p>
                        <div className="mt-2 space-y-1.5">
                          <div className="h-2 w-full rounded-full bg-indigo-100/60" />
                          <div className="h-2 w-5/6 rounded-full bg-indigo-100/60" />
                          <div className="h-2 w-full rounded-full bg-indigo-100/60" />
                        </div>
                      </div>
                      <div className="mt-4 space-y-2">
                        <div className="h-2 w-full rounded-full bg-slate-100" />
                        <div className="h-2 w-2/3 rounded-full bg-slate-100" />
                      </div>
                      <div className="mt-5 grid grid-cols-2 gap-3">
                        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2">
                          <p className="text-[10px] text-slate-400">Initials</p>
                          <div className="mt-1 h-7 rounded bg-slate-100" />
                        </div>
                        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2">
                          <p className="text-[10px] text-slate-400">Date</p>
                          <div className="mt-1 h-7 rounded bg-slate-100" />
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                      <div className="mb-4 flex items-center justify-between">
                        <div className="h-2 w-1/2 rounded-full bg-slate-200" />
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Page 2 of 2</span>
                      </div>
                      <div className="space-y-2">
                        <div className="h-2 w-full rounded-full bg-slate-100" />
                        <div className="h-2 w-4/5 rounded-full bg-slate-100" />
                        <div className="h-2 w-full rounded-full bg-slate-100" />
                      </div>
                      <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3">
                        <p className="text-[10px] text-slate-400">Authorized signature</p>
                        <div className="mt-2 h-10 rounded bg-slate-100" />
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">
                    Demo preview — upload a real PDF in{" "}
                    <a href="/crm/forms" className="text-indigo-500 underline underline-offset-2">CRM → Forms</a>{" "}
                    to see your actual document here
                  </p>
                </div>
              ) : (
                <div
                  className={`public-form-print-scroll bg-slate-100/80 p-3 ${
                    renderedPageCount > 1 ? "max-h-[calc(100vh-180px)] overflow-auto" : "overflow-visible"
                  }`}
                >
                  {pdfError ? (
                    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      PDF render error: {pdfError}
                    </div>
                  ) : null}
                  <div className="mx-auto flex max-w-3xl flex-col items-center gap-4">
                    {Array.from({ length: renderedPageCount }, (_, index) => {
                      const pageNumber = index + 1;
                      const pageSize = pageSizes[pageNumber];
                      const pageFields = form.fields.filter((field) => field.pageNumber === pageNumber);
                      return (
                        <div
                          key={pageNumber}
                          className="relative w-full overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-slate-200/70"
                          style={pageSize ? { width: pageSize.width, height: pageSize.height } : undefined}
                        >
                          <PdfPageCanvas
                            pdfUrl={pdfUrl}
                            pageNumber={pageNumber}
                            onSize={(size) => setPageSizes((prev) => ({ ...prev, [pageNumber]: size }))}
                            onError={setPdfError}
                          />
                          {pageSize ? (
                            <div
                              className="absolute inset-0"
                              style={{ width: pageSize.width, height: pageSize.height }}
                            >
                              {pageFields.map((field) => (
                                <PdfFieldOverlay
                                  key={field.id}
                                  field={field}
                                  value={values[field.id]}
                                  scale={pageSize.scale}
                                  pageFields={pageFields}
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Right — Fields */}
            <aside className="public-form-sidebar flex flex-col gap-4">

              {/* Progress pill */}
              {form.fields.length > 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-700">
                      {step === 1 ? "Fields to complete" : "Complete all fields"}
                    </p>
                    <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-bold text-indigo-700">
                      {completedCount} / {form.fields.length} done
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all"
                      style={{ width: `${form.fields.length ? (completedCount / form.fields.length) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {/* Fields */}
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="divide-y divide-slate-100">
                  {form.fields.map((field, idx) => (
                    <div
                      key={field.id}
                      id={`field-${field.id}`}
                      className="p-4"
                    >
                      <label className="mb-2 flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-600">
                          {idx + 1}
                        </span>
                        <span className="text-sm font-semibold text-slate-800">
                          {field.label}
                          {field.required ? <span className="ml-1 text-red-400">*</span> : <span className="ml-1 text-xs font-normal text-slate-400">(optional)</span>}
                        </span>
                      </label>
                      <FieldInput
                        field={field}
                        value={values[field.id]}
                        onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
                        error={fieldErrors[field.id]}
                        prefilled={Boolean(
                          field.autoFillToken &&
                          field.defaultValue !== undefined &&
                          field.defaultValue !== "" &&
                          String(values[field.id] ?? "") === field.defaultValue,
                        )}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Legal consent + submit */}
              {step === 2 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs leading-relaxed text-slate-500">
                    By clicking <strong>Submit</strong> below, you agree that your electronic signature and initials constitute your legal binding agreement, having the same legal force as a handwritten signature under applicable electronic signature laws.
                  </p>
                  {error ? (
                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
                  ) : null}
                  {totalRequired > 0 && Object.keys(requiredMissing).length > 0 ? (
                    <p className="mt-2 text-xs text-amber-600">
                      {Object.keys(requiredMissing).length} required {Object.keys(requiredMissing).length === 1 ? "field" : "fields"} still need{Object.keys(requiredMissing).length === 1 ? "s" : ""} to be completed.
                    </p>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={submit}
                      disabled={submitting}
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-60"
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Submitting…
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-4 w-4" />
                          Submit signed form
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Trust footer */}
              <div className="flex items-center justify-center gap-2 pb-2 text-xs text-slate-400">
                <Shield className="h-3.5 w-3.5 text-slate-300" />
                Powered by Connect CRM · All submissions are encrypted and timestamped
              </div>
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}
