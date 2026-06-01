"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import ImageExtension from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import {
  Archive,
  Bot,
  ChevronDown,
  Clipboard,
  Code2,
  Columns3,
  Copy,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Image,
  ImagePlus,
  Italic,
  LayoutTemplate,
  Link as LinkIcon,
  Loader2,
  Mail,
  Menu,
  Minus,
  Monitor,
  MoreHorizontal,
  MousePointerClick,
  Paperclip,
  PenLine,
  Plus,
  Save,
  Search,
  Send,
  Smartphone,
  Sparkles,
  Star,
  Tablet,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  UploadCloud,
  Wand2,
  X,
} from "lucide-react";
import {
  CRM_EMAIL_MERGE_FIELDS,
  CRM_EMAIL_TEMPLATE_CATEGORIES,
  plainTextToCrmHtml,
  renderCrmMergeTemplate,
  type CrmEmailBrandingInput,
  type CrmEmailMergeField,
  type CrmEmailSignatureInput,
} from "@connect/shared";
import { CRMPageShell, cn } from "../../../../../../components/crm";
import { PermissionGate } from "../../../../../../components/PermissionGate";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  getPortalApiBaseUrl,
} from "../../../../../../services/apiClient";
import {
  editorFromTemplate,
  emptyEditor,
  formatBytes,
  renderPreviewHtml,
  SAMPLE_VALUES,
} from "../../../../../../components/crm/email/templates/helpers";
import type {
  Attachment,
  BuilderBlock,
  EditorState,
  SaveState,
  StarterTemplate,
  Template,
} from "../../../../../../components/crm/email/templates/types";

type LeftTab = "blocks" | "sections" | "saved";
type RightTab = "properties" | "ai" | "variables" | "assets";
type PreviewMode = "desktop" | "tablet" | "mobile" | "inbox";

const BLOCKS: BuilderBlock[] = [
  { group: "Content", label: "Text", icon: Type, html: "<p>Write your message here...</p>" },
  { group: "Media", label: "Image", icon: Image, html: '<p><img src="https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=900" alt="Office" /></p>' },
  { group: "Action", label: "Button", icon: MousePointerClick, html: '<p><a href="{{business.website}}">Get Started</a></p>' },
  { group: "Layout", label: "Divider", icon: Minus, html: "<hr />" },
  { group: "Layout", label: "Columns", icon: Columns3, html: '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px"><div><p>Column one</p></div><div><p>Column two</p></div></div>' },
  { group: "Layout", label: "Spacer", icon: LayoutTemplate, html: "<p><br></p>" },
  { group: "Social", label: "Social", icon: Sparkles, html: "<p>Follow us: {{business.website}}</p>" },
  { group: "Advanced", label: "HTML", icon: Code2, html: "<p><code>Custom HTML block</code></p>" },
  { group: "Identity", label: "Signature", icon: PenLine, html: "<p>{{sender.signature}}</p>" },
  { group: "Media", label: "Video", icon: Monitor, html: '<p><a href="{{business.website}}">Watch the video</a></p>' },
  { group: "Content", label: "Icons", icon: Star, html: "<p>★ Key benefit · ★ Fast setup · ★ Reliable support</p>" },
  { group: "Navigation", label: "Menu", icon: Menu, html: "<p>Home · Services · Contact</p>" },
];

const AI_ACTIONS = [
  "Generate complete email",
  "Rewrite selected section",
  "Shorten",
  "Expand",
  "Professional",
  "Friendly",
  "Follow-up",
  "Sales",
  "Support",
  "Appointment reminder",
  "Reactivate lead",
  "Generate subject lines",
];

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const tenant = localStorage.getItem("cc-admin-scope") === "GLOBAL" ? "" : localStorage.getItem("cc-tenant-id") || "";
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(tenant ? { "x-tenant-context": tenant } : {}),
  };
}

function attachmentIcon(attachment: Attachment) {
  const mime = attachment.mimeType || "";
  if (mime.includes("image")) return FileImage;
  if (mime.includes("spreadsheet") || mime.includes("csv")) return FileSpreadsheet;
  if (mime.includes("zip")) return FileArchive;
  if (mime.includes("pdf") || mime.includes("word")) return FileText;
  return File;
}

export default function CrmEmailTemplateBuilderPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [starters, setStarters] = useState<StarterTemplate[]>([]);
  const [branding, setBranding] = useState<CrmEmailBrandingInput>({});
  const [signature, setSignature] = useState<CrmEmailSignatureInput>({});
  const [editorState, setEditorState] = useState<EditorState | null>(() => emptyEditor());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fieldQuery, setFieldQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [previewColorMode, setPreviewColorMode] = useState<"light" | "dark">("light");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftTab>("blocks");
  const [rightTab, setRightTab] = useState<RightTab>("properties");
  const [aiPrompt, setAiPrompt] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      LinkExtension.configure({ openOnClick: false }),
      ImageExtension.configure({ allowBase64: false }),
    ],
    content: editorState?.bodyHtml || "",
    editorProps: {
      attributes: {
        class: "min-h-[590px] bg-white px-6 py-8 text-[15px] leading-7 text-slate-800 outline-none sm:px-10",
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setEditorState((cur) => cur ? { ...cur, bodyHtml: html, bodyText: editor.getText({ blockSeparator: "\n" }) } : cur);
      setDirty(true);
      setSaveState("dirty");
    },
  });
  const editorCommands = editor as any;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [templateRes, starterRes, brandingRes, signatureRes] = await Promise.all([
        apiGet<{ templates: Template[] }>("/crm/email/templates?includeArchived=true"),
        apiGet<{ starters: StarterTemplate[] }>("/crm/email/template-starters"),
        apiGet<{ branding: CrmEmailBrandingInput }>("/crm/email/branding"),
        apiGet<{ signature: CrmEmailSignatureInput }>("/crm/email/signature"),
      ]);
      setTemplates(templateRes.templates ?? []);
      setStarters(starterRes.starters ?? []);
      setBranding(brandingRes.branding ?? {});
      setSignature(signatureRes.signature ?? {});
    } catch (e: any) {
      setError(e?.message || "Failed to load email templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (editor && editorState && editor.getHTML() !== editorState.bodyHtml) {
      editor.commands.setContent(editorState.bodyHtml || "", { emitUpdate: false });
    }
  }, [editor, editorState?.id]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const selectedTemplate = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);
  const currentAttachments = selectedTemplate?.attachments ?? [];

  const previewHtml = useMemo(
    () => editorState ? renderPreviewHtml(editorState, branding, signature, previewColorMode === "dark") : "",
    [editorState, branding, signature, previewColorMode],
  );
  const previewSubject = useMemo(() => editorState ? renderCrmMergeTemplate(editorState.subject, SAMPLE_VALUES) : "", [editorState]);
  const previewText = useMemo(() => editorState ? renderCrmMergeTemplate(editorState.previewText, SAMPLE_VALUES) : "", [editorState]);

  const fieldGroups = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    const fields = CRM_EMAIL_MERGE_FIELDS.filter((f) => !q || `${f.group} ${f.label} ${f.token}`.toLowerCase().includes(q));
    return fields.reduce<Record<string, CrmEmailMergeField[]>>((acc, field) => {
      acc[field.group] = [...(acc[field.group] || []), field];
      return acc;
    }, {});
  }, [fieldQuery]);

  const save = useCallback(async (draft: boolean, silent = false) => {
    if (!editorState) return;
    setSaving(true);
    setSaveState(silent ? "autosaving" : saveState);
    setError(null);
    try {
      const payload = {
        ...editorState,
        isDraft: draft,
        bodyHtml: editor?.getHTML() || editorState.bodyHtml,
        bodyJson: editor?.getJSON(),
      };
      const saved = editorState.id
        ? await apiPut<Template>(`/crm/email/templates/${editorState.id}`, payload as any)
        : await apiPost<Template>("/crm/email/templates", payload as any);
      setSelectedId(saved.id);
      setEditorState(editorFromTemplate(saved));
      setDirty(false);
      setSaveState("saved");
      if (!silent) setNotice(draft ? "Draft saved" : "Template saved");
      await load();
    } catch (e: any) {
      setSaveState("dirty");
      if (!silent) setError(e?.message || "Failed to save template");
    } finally {
      setSaving(false);
    }
  }, [editor, editorState, load, saveState]);

  useEffect(() => {
    if (!dirty || !editorState?.id || saving) return;
    const timer = window.setTimeout(() => void save(true, true), 2500);
    return () => window.clearTimeout(timer);
  }, [dirty, editorState, saving, save]);

  const updateEditor = (patch: Partial<EditorState>) => {
    setEditorState((cur) => cur ? { ...cur, ...patch } : cur);
    setDirty(true);
    setSaveState("dirty");
  };

  const applyStarter = (starter: StarterTemplate) => {
    if (dirty && !confirm("You have unsaved changes. Apply this starter anyway?")) return;
    const next: EditorState = {
      ...emptyEditor(),
      name: starter.name,
      category: starter.category,
      subject: starter.subject,
      previewText: starter.previewText,
      bodyText: starter.bodyText,
      bodyHtml: starter.bodyHtml || plainTextToCrmHtml(starter.bodyText),
      isDraft: true,
    };
    setSelectedId(null);
    setEditorState(next);
    setDirty(true);
    setSaveState("dirty");
    editor?.commands.setContent(next.bodyHtml, { emitUpdate: false });
  };

  const duplicate = async (template = selectedTemplate) => {
    if (!template?.id) return;
    const copy = await apiPost<Template>(`/crm/email/templates/${template.id}/duplicate`);
    setNotice("Template duplicated");
    setSelectedId(copy.id);
    setEditorState(editorFromTemplate(copy));
    setDirty(false);
    await load();
  };

  const archive = async (template = selectedTemplate) => {
    if (!template?.id) return;
    if (!confirm("Archive this template? It will be hidden from the main library.")) return;
    await apiPost(`/crm/email/templates/${template.id}/archive`);
    setNotice("Template archived");
    setSelectedId(null);
    setEditorState(emptyEditor());
    setDirty(false);
    await load();
  };

  const sendTest = async () => {
    if (!editorState?.id) {
      setError("Save the template before sending a test.");
      return;
    }
    await apiPost(`/crm/email/templates/${editorState.id}/send-test`);
    setNotice("Test email queued");
  };

  const insertBlock = (html: string) => {
    editor?.chain().focus().insertContent(html).run();
  };

  const insertMergeField = (field: CrmEmailMergeField) => {
    editor?.chain().focus().insertContent(field.token).run();
  };

  const uploadMultipart = async (url: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    setUploadProgress(15);
    const progressTimer = window.setInterval(() => {
      setUploadProgress((cur) => cur == null ? null : Math.min(90, cur + 15));
    }, 250);
    try {
      const res = await fetch(url, { method: "POST", headers: authHeaders(), body: form });
      if (!res.ok) throw new Error("Upload failed");
      setUploadProgress(100);
      window.setTimeout(() => setUploadProgress(null), 600);
    } finally {
      window.clearInterval(progressTimer);
    }
  };

  const uploadAttachment = async (file: File) => {
    if (!editorState?.id) {
      setError("Save the template before adding attachments.");
      return;
    }
    await uploadMultipart(`${getPortalApiBaseUrl()}/crm/email/templates/${editorState.id}/attachments`, file);
    setNotice("Attachment uploaded");
    await load();
  };

  const uploadLogo = async (file: File) => {
    await uploadMultipart(`${getPortalApiBaseUrl()}/crm/email/branding/logo`, file);
    setNotice("Logo uploaded");
    await load();
  };

  const removeAttachment = async (attachmentId: string) => {
    if (!editorState?.id) return;
    await apiDelete(`/crm/email/templates/${editorState.id}/attachments/${attachmentId}`);
    setNotice("Attachment removed");
    await load();
  };

  const saveBranding = async () => {
    await apiPut("/crm/email/branding", branding as any);
    setNotice("Branding saved");
    await load();
  };

  const saveSignature = async () => {
    await apiPut("/crm/email/signature", signature as any);
    setNotice("Signature saved");
    await load();
  };

  const runAi = async (action: string) => {
    if (!editorState) return;
    try {
      const res = await apiPost<{ subject: string; previewText: string; bodyText: string }>("/crm/email/templates/ai", {
        action,
        prompt: aiPrompt,
        subject: editorState.subject,
        bodyText: editorState.bodyText,
        category: editorState.category,
      }, undefined, { timeoutMs: 30000 });
      const next = {
        ...editorState,
        subject: res.subject || editorState.subject,
        previewText: res.previewText || editorState.previewText,
        bodyText: res.bodyText,
        bodyHtml: plainTextToCrmHtml(res.bodyText),
      };
      setEditorState(next);
      editor?.commands.setContent(next.bodyHtml, { emitUpdate: false });
      setDirty(true);
      setSaveState("dirty");
      setNotice("AI draft applied");
    } catch (e: any) {
      setError(e?.message || "AI Assistant is unavailable");
    }
  };

  const copyField = (field: CrmEmailMergeField) => {
    void navigator.clipboard?.writeText(field.token);
    setNotice("Merge field copied");
  };

  const saveLabel =
    saveState === "autosaving" ? "Autosaved just now" :
    saveState === "dirty" ? "Unsaved changes" :
    saveState === "saved" ? "Saved" : "Ready";
  const statusLabel = editorState?.isDraft ? "Draft" : saveState === "saved" ? "Saved" : "Ready";

  return (
    <PermissionGate permission="can_view_crm_email" fallback={<div className="state-box">You do not have CRM Email access.</div>}>
      <CRMPageShell innerClassName="mx-auto flex w-full max-w-[min(100%,1900px)] flex-col gap-3 px-2 py-3 sm:px-4">
        <div className="sticky top-[var(--topbar-height,0px)] z-30 rounded-[1.5rem] border border-slate-200/80 bg-white/95 px-3 py-2 shadow-[0_18px_60px_-48px_rgba(15,23,42,0.9)] backdrop-blur xl:px-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-bold text-slate-500">
                <Link href="/crm/email/templates" className="hover:text-blue-600">Email Studio</Link>
                <span>/</span>
                <span className="text-slate-900">{editorState?.name || "New Template"}</span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  className="h-11 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-lg font-black tracking-tight text-slate-950 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100 sm:max-w-md"
                  value={editorState?.name || ""}
                  onChange={(event) => updateEditor({ name: event.target.value })}
                  aria-label="Template title"
                />
                <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-3 py-1 text-xs font-black", editorState?.isDraft ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" /> {statusLabel}
                </span>
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
                  <Sparkles className="h-3.5 w-3.5" /> {saveLabel}
                </span>
              </div>
            </div>
            <div className="relative flex flex-wrap items-center gap-2">
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:border-blue-200 hover:text-blue-700" onClick={sendTest}>
                <Send className="mr-2 inline h-4 w-4" /> Test Email
              </button>
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:border-blue-200 hover:text-blue-700" onClick={() => setPreviewOpen(true)}>
                <Monitor className="mr-2 inline h-4 w-4" /> Preview
              </button>
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:border-blue-200 hover:text-blue-700" onClick={() => setMoreOpen((open) => !open)}>
                <MoreHorizontal className="mr-2 inline h-4 w-4" /> More
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-52 rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl">
                  <button type="button" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50" onClick={() => { setMoreOpen(false); updateEditor({ isFavorite: !editorState?.isFavorite }); }}>
                    <Star className="h-4 w-4" /> {editorState?.isFavorite ? "Remove favorite" : "Favorite"}
                  </button>
                  <button type="button" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50" onClick={() => { setMoreOpen(false); void duplicate(); }} disabled={!editorState?.id}>
                    <Copy className="h-4 w-4" /> Duplicate
                  </button>
                  <button type="button" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50" onClick={() => { setMoreOpen(false); void archive(); }} disabled={!editorState?.id}>
                    <Archive className="h-4 w-4" /> Archive
                  </button>
                </div>
              )}
              <button type="button" className="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-black text-white shadow-[0_16px_34px_-18px_rgba(37,99,235,0.9)] hover:bg-blue-700" onClick={() => void save(false)} disabled={saving}>
                {saving ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Save className="mr-2 inline h-4 w-4" />} Save Template
              </button>
            </div>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">{notice}</div>}

        <div className="grid gap-3 xl:grid-cols-[290px_minmax(0,1fr)_330px] 2xl:grid-cols-[310px_minmax(720px,1fr)_360px]">
          <aside className="order-2 rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_56px_-44px_rgba(15,23,42,0.9)] xl:order-1 xl:max-h-[calc(100vh-190px)] xl:overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.22em] text-blue-600">Content</p>
                <p className="text-xs text-slate-500">Blocks and starters</p>
              </div>
              <X className="h-4 w-4 text-slate-300" />
            </div>
            <div className="border-b border-slate-100 px-3 py-2">
              <div className="grid grid-cols-3 rounded-2xl bg-slate-100 p-1 text-xs font-black">
                {(["blocks", "sections", "saved"] as const).map((tab) => (
                  <button key={tab} type="button" className={cn("rounded-xl px-2 py-2 capitalize text-slate-500", leftTab === tab && "bg-white text-blue-700 shadow-sm")} onClick={() => setLeftTab(tab)}>
                    {tab}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[calc(100vh-300px)] overflow-y-auto p-3">
              {leftTab === "blocks" && (
                <div className="grid grid-cols-2 gap-2">
                  {BLOCKS.map((block, index) => {
                    const Icon = block.icon;
                    const tones = ["bg-blue-50 text-blue-700", "bg-violet-50 text-violet-700", "bg-emerald-50 text-emerald-700", "bg-amber-50 text-amber-700"];
                    return (
                      <button
                        key={block.label}
                        type="button"
                        draggable
                        onDragStart={(event) => event.dataTransfer.setData("text/html", block.html)}
                        onClick={() => insertBlock(block.html)}
                        className="group min-h-[74px] rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
                      >
                        <span className={cn("mb-2 flex h-8 w-8 items-center justify-center rounded-xl", tones[index % tones.length])}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="block text-xs font-black text-slate-800">{block.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {leftTab === "sections" && (
                <div className="space-y-2">
                  {BLOCKS.filter((block) => ["Action", "Identity", "Layout"].includes(block.group)).map((block) => (
                    <button key={block.label} type="button" className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left text-sm font-bold text-slate-700 hover:border-blue-200 hover:bg-blue-50" onClick={() => insertBlock(block.html)}>
                      {block.group} · {block.label}
                    </button>
                  ))}
                </div>
              )}
              {leftTab === "saved" && (
                <div className="space-y-2">
                  {templates.filter((template) => !template.isArchived).slice(0, 8).map((template) => (
                    <button key={template.id} type="button" className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left hover:border-blue-200" onClick={() => {
                      if (dirty && !confirm("You have unsaved changes. Open another template anyway?")) return;
                      setSelectedId(template.id);
                      setEditorState(editorFromTemplate(template));
                      setDirty(false);
                      setSaveState("idle");
                    }}>
                      <span className="block truncate text-sm font-black text-slate-900">{template.name}</span>
                      <span className="mt-1 block truncate text-xs text-slate-500">{template.subject || "No subject"}</span>
                    </button>
                  ))}
                  {templates.length === 0 && <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">No saved templates yet.</p>}
                </div>
              )}
              <div className="mt-5 border-t border-slate-100 pt-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Starter Templates</h3>
                  <span className="text-xs font-bold text-blue-600">{starters.length} ready</span>
                </div>
                <div className="space-y-2">
                  {starters.map((starter) => (
                    <button key={starter.key} type="button" onClick={() => applyStarter(starter)} className="flex w-full gap-3 rounded-2xl border border-slate-200 bg-white p-2 text-left shadow-sm hover:border-blue-200 hover:bg-blue-50/50">
                      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
                        <Mail className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-black text-slate-900">{starter.name}</span>
                        <span className="block text-[11px] font-bold uppercase tracking-wide text-blue-600">{starter.category}</span>
                        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">{starter.previewText}</span>
                      </span>
                    </button>
                  ))}
                  {!loading && starters.length === 0 && <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">Starter templates are unavailable.</p>}
                </div>
              </div>
            </div>
          </aside>

          <main className="order-1 min-w-0 xl:order-2">
            <section className="overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_24px_80px_-52px_rgba(15,23,42,0.95)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                  <button type="button" className="rounded-xl p-2 text-slate-500 hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().undo().run()}>↶</button>
                  <button type="button" className="rounded-xl p-2 text-slate-500 hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().redo().run()}>↷</button>
                  {(["desktop", "tablet", "mobile", "inbox"] as const).map((mode) => {
                    const Icon = mode === "desktop" ? Monitor : mode === "tablet" ? Tablet : mode === "mobile" ? Smartphone : Mail;
                    return (
                      <button key={mode} type="button" className={cn("inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-black capitalize", previewMode === mode ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-100")} onClick={() => setPreviewMode(mode)}>
                        <Icon className="h-4 w-4" /> {mode === "inbox" ? "Inbox Preview" : mode}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-1 text-xs font-bold">
                  <button type="button" className="rounded-xl px-3 py-2 text-slate-500 hover:bg-slate-100" onClick={() => setPreviewColorMode(previewColorMode === "light" ? "dark" : "light")}>Theme</button>
                </div>
              </div>
              <div
                className="min-h-[680px] bg-[radial-gradient(circle_at_top,_rgba(79,70,229,0.10),transparent_35%),linear-gradient(180deg,#f8fafc,#f2f4ff)] px-3 py-6 sm:px-6"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const html = event.dataTransfer.getData("text/html");
                  if (html) insertBlock(html);
                }}
              >
                <div className={cn(
                  "mx-auto transition-all",
                  previewMode === "desktop" && "max-w-[760px]",
                  previewMode === "tablet" && "max-w-[620px]",
                  previewMode === "mobile" && "max-w-[360px]",
                  previewMode === "inbox" && "max-w-[760px]",
                )}>
                  {previewMode === "inbox" && (
                    <div className="mb-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                      <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">Inbox Preview</p>
                      <div className="mt-3 flex items-start gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-sm font-black text-white">{(signature.senderName || branding.businessName || "C").slice(0, 1)}</div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-slate-500">{signature.senderName || branding.businessName || "Your Company"} &lt;{signature.email || branding.email || "hello@yourcompany.com"}&gt;</p>
                          <p className="truncate text-sm font-black text-slate-950">{previewSubject || "Preview subject line"}</p>
                          <p className="truncate text-xs text-slate-500">{previewText || "Preview text appears here in the recipient inbox."}</p>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="overflow-hidden rounded-[1.35rem] bg-white shadow-[0_28px_80px_-46px_rgba(15,23,42,0.95)] ring-1 ring-slate-200/80">
                    <EditorContent editor={editor} />
                  </div>
                </div>
                <div
                  className="mx-auto mt-4 flex max-w-[900px] items-center justify-center rounded-2xl border border-dashed border-blue-200 bg-white/70 py-4 text-xs font-bold text-blue-700"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const html = event.dataTransfer.getData("text/html");
                    if (html) insertBlock(html);
                  }}
                >
                  Drop a block here or browse blocks
                </div>
              </div>
            </section>
          </main>

          <aside className="order-3 rounded-[1.5rem] border border-slate-200/80 bg-white shadow-[0_18px_56px_-44px_rgba(15,23,42,0.9)] xl:max-h-[calc(100vh-190px)] xl:overflow-hidden">
            <div className="border-b border-slate-100 p-3">
              <div className="grid grid-cols-4 rounded-2xl bg-slate-100 p-1 text-[11px] font-black">
                {([
                  ["properties", "Properties"],
                  ["ai", "AI Assistant"],
                  ["variables", "Variables"],
                  ["assets", "Assets"],
                ] as const).map(([key, label]) => (
                  <button key={key} type="button" className={cn("rounded-xl px-2 py-2 text-slate-500", rightTab === key && "bg-white text-blue-700 shadow-sm")} onClick={() => setRightTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="max-h-[calc(100vh-265px)] overflow-y-auto p-4">
              {rightTab === "properties" && (
                <div className="space-y-5">
                  <PanelTitle title="Branding" />
                  <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0];
                    if (file) void uploadLogo(file);
                  }}>
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-white text-blue-600 shadow-sm">
                        {branding.logoUrl ? <img src={branding.logoUrl} alt="" className="h-full w-full object-contain" /> : <ImagePlus className="h-5 w-5" />}
                      </div>
                      <label className="flex-1 cursor-pointer rounded-2xl border border-slate-200 bg-white px-3 py-2 text-center text-xs font-black text-slate-600 hover:border-blue-200 hover:text-blue-700">
                        Replace
                        <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadLogo(file);
                          event.currentTarget.value = "";
                        }} />
                      </label>
                      <button type="button" className="rounded-xl p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => setBranding((cur) => ({ ...cur, logoUrl: null }))}><X className="h-4 w-4" /></button>
                    </div>
                  </div>
                  <FieldGrid fields={[
                    ["businessName", "Company Name", branding.businessName || "", (value) => setBranding({ ...branding, businessName: value })],
                    ["phone", "Business Phone", branding.phone || "", (value) => setBranding({ ...branding, phone: value })],
                    ["website", "Website", branding.website || "", (value) => setBranding({ ...branding, website: value })],
                    ["address", "Address", branding.address || "", (value) => setBranding({ ...branding, address: value })],
                  ]} />
                  <button type="button" className="w-full rounded-2xl bg-blue-50 px-3 py-2 text-sm font-black text-blue-700" onClick={() => void saveBranding()}>Save branding</button>

                  <PanelTitle title="Global Styles" />
                  <label className="block text-[11px] font-black uppercase tracking-wide text-slate-400">
                    Primary Color
                    <input className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 outline-none" value="Connect Blue" disabled title="Primary color is not configurable in the current branding API." />
                  </label>

                  <PanelTitle title="Email Settings" />
                  <FieldGrid fields={[
                    ["senderName", "Sender Name", signature.senderName || "", (value) => setSignature({ ...signature, senderName: value })],
                    ["senderTitle", "Sender Title", signature.senderTitle || "", (value) => setSignature({ ...signature, senderTitle: value })],
                    ["phone", "Sender Phone", signature.phone || "", (value) => setSignature({ ...signature, phone: value })],
                    ["email", "Sender Email", signature.email || "", (value) => setSignature({ ...signature, email: value })],
                  ]} />
                  <button type="button" className="w-full rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-700" onClick={() => void saveSignature()}>Save sender identity</button>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 text-xs leading-5 text-slate-500">
                    Footer preview: {branding.businessName || "Your Company"} · {branding.address || "Business address"} · Privacy / unsubscribe links
                  </div>
                </div>
              )}

              {rightTab === "ai" && (
                <div className="space-y-4">
                  <div className="rounded-3xl border border-blue-100 bg-blue-50/70 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-black text-slate-950"><Bot className="h-4 w-4 text-blue-700" /> AI Assistant</h3>
                    <p className="mt-1 text-xs text-slate-500">Write better emails, faster.</p>
                  </div>
                  <textarea className="h-28 w-full resize-none rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" placeholder="Ask AI to write, rewrite, or improve your email..." value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} />
                  <div className="grid grid-cols-2 gap-2">
                    {AI_ACTIONS.map((action) => (
                      <button key={action} type="button" className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700" onClick={() => void runAi(action)}>
                        {action}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {rightTab === "variables" && (
                <div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input className="w-full rounded-2xl border border-slate-200 px-3 py-2 pl-9 text-sm outline-none focus:border-blue-300" placeholder="Search merge fields..." value={fieldQuery} onChange={(event) => setFieldQuery(event.target.value)} />
                  </div>
                  <div className="mt-4 space-y-4">
                    {Object.entries(fieldGroups).map(([group, fields]) => (
                      <div key={group}>
                        <div className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{group}</div>
                        <div className="space-y-2">
                          {fields.map((field) => (
                            <div key={field.token} className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-black text-slate-800">{field.label}</p>
                                <p className="truncate text-[11px] text-slate-400">{field.sample || field.token}</p>
                              </div>
                              <button title="Copy token" type="button" onClick={() => copyField(field)} className="rounded-xl p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"><Clipboard className="h-3.5 w-3.5" /></button>
                              <button title="Insert token" type="button" onClick={() => insertMergeField(field)} className="rounded-xl bg-blue-600 px-2 py-1 text-[11px] font-black text-white">Insert</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {rightTab === "assets" && (
                <div className="space-y-4">
                  <PanelTitle title="Attachments" action={(
                    <label className="cursor-pointer text-xs font-black text-blue-700">
                      Add Files
                      <input type="file" className="hidden" onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadAttachment(file);
                        event.currentTarget.value = "";
                      }} />
                    </label>
                  )} />
                  <div className={cn("rounded-3xl border border-dashed p-5 text-center", uploadProgress != null ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50")} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0];
                    if (file) void uploadAttachment(file);
                  }}>
                    <UploadCloud className="mx-auto h-6 w-6 text-blue-500" />
                    <p className="mt-2 text-xs font-bold text-slate-700">{uploadProgress != null ? `Uploading ${uploadProgress}%` : "Drag files here or upload"}</p>
                    <p className="mt-1 text-[11px] text-slate-400">PDF, DOCX, XLSX, CSV, JPG, PNG, WEBP</p>
                  </div>
                  <div className="space-y-2">
                    {currentAttachments.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-3 py-3 text-center text-xs text-slate-500">No template attachments yet.</p>
                    ) : currentAttachments.map((attachment) => {
                      const Icon = attachmentIcon(attachment);
                      return (
                        <div key={attachment.id} className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3 py-2 text-sm shadow-sm">
                          <Icon className="h-4 w-4 shrink-0 text-blue-600" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-bold text-slate-800">{attachment.originalFileName}</p>
                            <p className="text-xs text-slate-400">{formatBytes(attachment.sizeBytes)}</p>
                          </div>
                          <button title="Remove" type="button" onClick={() => void removeAttachment(attachment.id)} className="rounded-xl p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className="sticky bottom-3 z-20 rounded-[1.35rem] border border-slate-200 bg-white/95 p-2 shadow-[0_18px_60px_-38px_rgba(15,23,42,0.9)] backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:border-blue-200" onClick={() => void save(true)} disabled={saving}><Save className="mr-2 inline h-4 w-4" /> Save Draft</button>
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:border-blue-200" onClick={sendTest}><Send className="mr-2 inline h-4 w-4" /> Send Test</button>
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:border-blue-200 disabled:opacity-50" onClick={() => void duplicate()} disabled={!editorState?.id}><Copy className="mr-2 inline h-4 w-4" /> Duplicate</button>
              <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:border-blue-200 disabled:opacity-50" onClick={() => void archive()} disabled={!editorState?.id}><Archive className="mr-2 inline h-4 w-4" /> Archive</button>
              <button type="button" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-2 text-sm font-bold text-red-700 disabled:opacity-50" onClick={() => void archive()} disabled={!editorState?.id} title="Permanent delete is not supported; this archives the template."><Trash2 className="mr-2 inline h-4 w-4" /> Delete</button>
            </div>
            <button type="button" className="rounded-2xl bg-blue-600 px-5 py-2 text-sm font-black text-white shadow-[0_16px_34px_-18px_rgba(37,99,235,0.9)] hover:bg-blue-700" onClick={() => void save(false)} disabled={saving}>
              {saving ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Save className="mr-2 inline h-4 w-4" />} Save Template <ChevronDown className="ml-2 inline h-4 w-4" />
            </button>
          </div>
        </div>

        {previewOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
            <section className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[2rem] bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600">Email Preview</p>
                  <h2 className="text-xl font-black text-slate-950">{editorState?.name || "New Template"}</h2>
                </div>
                <button type="button" className="rounded-2xl border border-slate-200 bg-white p-2 text-slate-500" onClick={() => setPreviewOpen(false)}><X className="h-5 w-5" /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-5">
                <div className="mx-auto max-w-3xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
                  <iframe title="Email preview" className="h-[700px] w-full bg-white" srcDoc={previewHtml} />
                </div>
              </div>
            </section>
          </div>
        )}
      </CRMPageShell>
    </PermissionGate>
  );
}

function PanelTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">{title}</h3>
      {action}
    </div>
  );
}

function FieldGrid({
  fields,
}: {
  fields: Array<[string, string, string, (value: string) => void]>;
}) {
  return (
    <div className="grid gap-3">
      {fields.map(([key, label, value, onChange]) => (
        <label key={key} className="block text-[11px] font-black uppercase tracking-wide text-slate-400">
          {label}
          <input className="mt-2 h-10 w-full rounded-2xl border border-slate-200 px-3 text-sm normal-case tracking-normal text-slate-800 outline-none focus:border-blue-300" value={value} onChange={(event) => onChange(event.target.value)} />
        </label>
      ))}
    </div>
  );
}
