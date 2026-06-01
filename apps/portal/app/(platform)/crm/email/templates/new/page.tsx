"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import ImageExtension from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import {
  Image,
  LayoutTemplate,
  Mail,
  MoreHorizontal,
  Paperclip,
  Plus,
  Sparkles,
  Type,
} from "lucide-react";
import {
  CRM_EMAIL_MERGE_FIELDS,
  plainTextToCrmHtml,
  renderCrmMergeTemplate,
  type CrmEmailBrandingInput,
  type CrmEmailMergeField,
  type CrmEmailSignatureInput,
} from "@connect/shared";
import { CRMPageShell, crm, cn } from "../../../../../../components/crm";
import { PermissionGate } from "../../../../../../components/PermissionGate";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  getPortalApiBaseUrl,
} from "../../../../../../services/apiClient";
import { EmailBuilderCanvas } from "../../../../../../components/crm/email/templates/EmailBuilderCanvas";
import { EmailPreviewPanel } from "../../../../../../components/crm/email/templates/EmailPreviewPanel";
import { StarterTemplatesStrip } from "../../../../../../components/crm/email/templates/StarterTemplatesStrip";
import { TemplateLibraryPanel } from "../../../../../../components/crm/email/templates/TemplateLibraryPanel";
import { UtilityPanels } from "../../../../../../components/crm/email/templates/UtilityPanels";
import {
  editorFromTemplate,
  emptyEditor,
  renderPreviewHtml,
  SAMPLE_VALUES,
} from "../../../../../../components/crm/email/templates/helpers";
import type {
  BuilderBlock,
  EditorState,
  SaveState,
  StarterTemplate,
  Template,
  TemplateFolder,
} from "../../../../../../components/crm/email/templates/types";

const BLOCKS: BuilderBlock[] = [
  { group: "Content", label: "Text", icon: Type, html: "<p>Write your message here...</p>" },
  { group: "Media", label: "Images", icon: Image, html: '<p><img src="https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=900" alt="Office" /></p>' },
  { group: "Action", label: "Buttons", icon: LayoutTemplate, html: '<p><a href="{{business.website}}">Schedule a Call</a></p>' },
  { group: "Layout", label: "Dividers", icon: MoreHorizontal, html: "<hr />" },
  { group: "Layout", label: "Spacers", icon: LayoutTemplate, html: "<p><br></p>" },
  { group: "Social", label: "Social Links", icon: Sparkles, html: "<p>Follow us: {{business.website}}</p>" },
  { group: "Identity", label: "Signature", icon: Mail, html: "<p>{{sender.signature}}</p>" },
  { group: "Identity", label: "Logo", icon: Image, html: "<p><strong>{{business.name}}</strong></p>" },
  { group: "Identity", label: "Contact Info", icon: Mail, html: "<p>{{business.phone}} &middot; {{business.email}}</p>" },
  { group: "Action", label: "Call To Action", icon: LayoutTemplate, html: '<p><a href="{{business.website}}">Get Started</a></p>' },
  { group: "Files", label: "Attachment", icon: Paperclip, html: "<p>Please see the attached file for details.</p>" },
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

export default function CrmEmailTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [starters, setStarters] = useState<StarterTemplate[]>([]);
  const [branding, setBranding] = useState<CrmEmailBrandingInput>({});
  const [signature, setSignature] = useState<CrmEmailSignatureInput>({});
  const [editorState, setEditorState] = useState<EditorState | null>(() => emptyEditor());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folder, setFolder] = useState<TemplateFolder["key"]>("all");
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [fieldQuery, setFieldQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [previewColorMode, setPreviewColorMode] = useState<"light" | "dark">("light");
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
        class: "min-h-[500px] bg-white px-6 py-7 text-[14px] leading-7 text-slate-800 outline-none sm:px-9",
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      setEditorState((cur) => cur ? { ...cur, bodyHtml: html, bodyText: editor.getText({ blockSeparator: "\n" }) } : cur);
      setDirty(true);
      setSaveState("dirty");
    },
  });

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
      const nextTemplates = templateRes.templates ?? [];
      setTemplates(nextTemplates);
      setStarters(starterRes.starters ?? []);
      setBranding(brandingRes.branding ?? {});
      setSignature(signatureRes.signature ?? {});
      if (!editorState) {
        const first = nextTemplates.find((t) => !t.isArchived);
        if (first) {
          setSelectedId(first.id);
          setEditorState(editorFromTemplate(first));
        }
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load email templates");
    } finally {
      setLoading(false);
    }
  }, [editorState]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      let saved: Template;
      if (editorState.id) saved = await apiPut<Template>(`/crm/email/templates/${editorState.id}`, payload as any);
      else saved = await apiPost<Template>("/crm/email/templates", payload as any);
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

  const selectedTemplate = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);
  const currentAttachments = selectedTemplate?.attachments ?? [];

  const counts = useMemo(() => {
    const active = templates.filter((t) => !t.isArchived);
    return {
      all: active.length,
      favorites: active.filter((t) => t.isFavorite).length,
      recent: active.filter((t) => t.lastUsedAt).length,
      drafts: active.filter((t) => t.isDraft).length,
      archived: templates.filter((t) => t.isArchived).length,
    };
  }, [templates]);

  const folders: TemplateFolder[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "favorites", label: "Favorites", count: counts.favorites },
    { key: "recent", label: "Recent", count: counts.recent },
    { key: "drafts", label: "Drafts", count: counts.drafts },
    { key: "archived", label: "Archived", count: counts.archived },
  ];

  const filtered = useMemo(() => templates.filter((t) => {
    const q = query.trim().toLowerCase();
    if (folder !== "archived" && t.isArchived) return false;
    if (folder === "archived" && !t.isArchived) return false;
    if (folder === "favorites" && !t.isFavorite) return false;
    if (folder === "recent" && !t.lastUsedAt) return false;
    if (folder === "drafts" && !t.isDraft) return false;
    if (category !== "All" && (t.category || "Custom") !== category) return false;
    if (q && !`${t.name} ${t.subject} ${t.category}`.toLowerCase().includes(q)) return false;
    return true;
  }), [templates, folder, category, query]);

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

  const updateEditor = (patch: Partial<EditorState>) => {
    setEditorState((cur) => cur ? { ...cur, ...patch } : cur);
    setDirty(true);
    setSaveState("dirty");
  };

  const openTemplate = (template: Template) => {
    if (dirty && !confirm("You have unsaved changes. Open another template anyway?")) return;
    setSelectedId(template.id);
    setEditorState(editorFromTemplate(template));
    setDirty(false);
    setSaveState("idle");
  };

  const newTemplate = () => {
    if (dirty && !confirm("You have unsaved changes. Start a new template anyway?")) return;
    const next = emptyEditor();
    setSelectedId(null);
    setEditorState(next);
    setDirty(true);
    setSaveState("dirty");
    editor?.commands.setContent(next.bodyHtml, { emitUpdate: false });
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
    if (selectedId === template.id) {
      setSelectedId(null);
      setEditorState(null);
      setDirty(false);
    }
    await load();
  };

  const restore = async (template: Template) => {
    await apiPut(`/crm/email/templates/${template.id}`, { isArchived: false });
    setNotice("Template restored");
    await load();
  };

  const favorite = async (template: Template) => {
    const updated = await apiPut<Template>(`/crm/email/templates/${template.id}`, { isFavorite: !template.isFavorite });
    if (selectedId === template.id) setEditorState(editorFromTemplate(updated));
    await load();
  };

  const rename = async (template: Template) => {
    const name = prompt("Rename template", template.name)?.trim();
    if (!name || name === template.name) return;
    const updated = await apiPut<Template>(`/crm/email/templates/${template.id}`, { name });
    if (selectedId === template.id) setEditorState(editorFromTemplate(updated));
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

  return (
    <PermissionGate permission="can_view_crm_email" fallback={<div className="state-box">You do not have CRM Email access.</div>}>
      <CRMPageShell innerClassName="crm-email-builder-inner mx-auto flex w-full max-w-[min(100%,1840px)] flex-col gap-3 px-3 py-4 sm:px-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-[1.75rem] border border-slate-200/80 bg-white/95 px-4 py-3 shadow-[0_18px_60px_-45px_rgba(15,23,42,0.85)]">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-blue-600">
              <Mail className="h-4 w-4" /> CRM Email Studio
            </div>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-950">Email Templates</h1>
            <p className="text-sm text-slate-500">Premium no-code email builder for high-converting CRM workflows.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-500">{dirty ? "Unsaved changes" : saveState === "saved" ? "All changes saved" : "Ready"}</div>
            <button type="button" className={cn(crm.btnSecondary, "bg-white text-slate-700")} disabled>Import Template</button>
            <button type="button" className={crm.btnPrimary} onClick={newTemplate}><Plus className="h-4 w-4" /> New Template</button>
          </div>
        </header>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{notice}</div>}

        <div className="grid min-h-[740px] grid-cols-1 gap-3 2xl:grid-cols-[320px_minmax(0,1fr)_390px]">
          <TemplateLibraryPanel
            templates={templates}
            filtered={filtered}
            selectedId={selectedId}
            loading={loading}
            query={query}
            category={category}
            folder={folder}
            folders={folders}
            onQueryChange={setQuery}
            onCategoryChange={setCategory}
            onFolderChange={setFolder}
            onOpen={openTemplate}
            onFavorite={favorite}
            onDuplicate={duplicate}
            onArchive={archive}
            onRestore={restore}
            onRename={rename}
          />

          <EmailBuilderCanvas
            editor={editor}
            editorState={editorState}
            blocks={BLOCKS}
            saving={saving}
            saveState={saveState}
            onChange={updateEditor}
            onInsertBlock={insertBlock}
            onDropBlock={insertBlock}
            onSaveDraft={() => void save(true)}
            onSaveTemplate={() => void save(false)}
            onSendTest={sendTest}
            onDuplicate={() => void duplicate()}
            onArchive={() => void archive()}
          />

          <EmailPreviewPanel
            html={previewHtml}
            subject={previewSubject}
            previewText={previewText}
            senderName={signature.senderName || branding.businessName || "Your Company"}
            senderEmail={signature.email || branding.email || "hello@yourcompany.com"}
            attachments={currentAttachments}
            previewMode={previewMode}
            colorMode={previewColorMode}
            onPreviewModeChange={setPreviewMode}
            onColorModeChange={setPreviewColorMode}
          />
        </div>

        <UtilityPanels
          editor={editor}
          branding={branding}
          signature={signature}
          attachments={currentAttachments}
          fieldQuery={fieldQuery}
          fieldGroups={fieldGroups}
          aiPrompt={aiPrompt}
          uploadProgress={uploadProgress}
          onBrandingChange={setBranding}
          onSignatureChange={setSignature}
          onSaveBranding={saveBranding}
          onSaveSignature={saveSignature}
          onLogoUpload={(file) => void uploadLogo(file)}
          onLogoRemove={() => setBranding((cur) => ({ ...cur, logoUrl: null }))}
          onAttachmentUpload={(file) => void uploadAttachment(file)}
          onAttachmentRemove={(id) => void removeAttachment(id)}
          onMergeQueryChange={setFieldQuery}
          onInsertField={insertMergeField}
          onCopyField={copyField}
          onAiPromptChange={setAiPrompt}
          onRunAi={(action) => void runAi(action)}
        />

        <StarterTemplatesStrip starters={starters} onApply={applyStarter} />
      </CRMPageShell>
    </PermissionGate>
  );
}
