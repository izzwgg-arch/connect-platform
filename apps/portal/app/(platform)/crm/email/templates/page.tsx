"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BarChart3,
  CalendarClock,
  ChevronDown,
  Copy,
  Edit3,
  Eye,
  FileText,
  FolderOpen,
  Grid3X3,
  Inbox,
  LayoutGrid,
  Mail,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  Search,
  Send,
  Sparkles,
  Star,
  Tags,
  Wand2,
} from "lucide-react";
import {
  CRM_EMAIL_TEMPLATE_CATEGORIES,
  plainTextToCrmHtml,
  renderCrmMergeTemplate,
  type CrmEmailBrandingInput,
  type CrmEmailSignatureInput,
} from "@connect/shared";
import { CRMPageShell, cn } from "../../../../../components/crm";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import {
  editorFromTemplate,
  emptyEditor,
  renderPreviewHtml,
  SAMPLE_VALUES,
  relativeTime,
} from "../../../../../components/crm/email/templates/helpers";
import type {
  EditorState,
  StarterTemplate,
  Template,
  TemplateFolder,
} from "../../../../../components/crm/email/templates/types";

type PreviewTab = "preview" | "details" | "usage" | "activity";
type ViewMode = "grid" | "list";
type SortKey = "updated" | "name" | "usage";

const FEATURED_TABS = [
  "All Templates",
  "Favorites",
  "Sales",
  "Follow-up",
  "Appointment",
  "Marketing",
  "More",
] as const;

const CATEGORY_ACCENTS = [
  "from-blue-500 to-indigo-500",
  "from-violet-500 to-fuchsia-500",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-cyan-500 to-blue-500",
  "from-rose-500 to-pink-500",
] as const;

function stripHtml(input?: string | null): string {
  if (!input) return "";
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(input?: string | null): string {
  if (!input) return "Never";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "Recently";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function getCategory(template: Template): string {
  return template.category || "Custom";
}

function getSnippet(template: Template): string {
  return template.previewText || stripHtml(template.bodyHtml) || template.bodyText || "No preview text yet.";
}

function getVariables(template: Template): string[] {
  const haystack = `${template.subject || ""} ${template.previewText || ""} ${template.bodyText || ""} ${template.bodyHtml || ""}`;
  return Array.from(new Set(haystack.match(/{{\s*[^}]+\s*}}/g) || [])).slice(0, 12);
}

export default function CrmEmailTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [starters, setStarters] = useState<StarterTemplate[]>([]);
  const [branding, setBranding] = useState<CrmEmailBrandingInput>({});
  const [signature, setSignature] = useState<CrmEmailSignatureInput>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folder, setFolder] = useState<TemplateFolder["key"]>("all");
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("preview");
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerState, setComposerState] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId],
  );
  const selectedEditor = useMemo(
    () => selectedTemplate ? editorFromTemplate(selectedTemplate) : null,
    [selectedTemplate],
  );
  const selectedVariables = useMemo(
    () => selectedTemplate ? getVariables(selectedTemplate) : [],
    [selectedTemplate],
  );

  const counts = useMemo(() => {
    const active = templates.filter((template) => !template.isArchived);
    return {
      total: templates.length,
      active: active.filter((template) => !template.isDraft).length,
      drafts: active.filter((template) => template.isDraft).length,
      archived: templates.filter((template) => template.isArchived).length,
      favorites: active.filter((template) => template.isFavorite).length,
    };
  }, [templates]);

  const folders: TemplateFolder[] = useMemo(() => [
    { key: "all", label: "All Templates", count: counts.total },
    { key: "favorites", label: "Favorites", count: counts.favorites },
    {
      key: "recent",
      label: "Recently Used",
      count: templates.filter((template) => Boolean(template.lastUsedAt) && !template.isArchived).length,
    },
    { key: "drafts", label: "Drafts", count: counts.drafts },
    { key: "archived", label: "Archived", count: counts.archived },
  ], [counts, templates]);

  const categoryCounts = useMemo(() => {
    const active = templates.filter((template) => !template.isArchived);
    return active.reduce<Record<string, number>>((acc, template) => {
      const key = getCategory(template);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }, [templates]);

  const tabCounts = useMemo(() => ({
    "All Templates": templates.filter((template) => !template.isArchived).length,
    Favorites: counts.favorites,
    Sales: categoryCounts.Sales || 0,
    "Follow-up": categoryCounts["Follow-up"] || 0,
    Appointment: categoryCounts.Appointment || 0,
    Marketing: categoryCounts.Marketing || 0,
    More: templates.filter((template) => {
      const templateCategory = getCategory(template);
      return !template.isArchived && !["Sales", "Follow-up", "Appointment", "Marketing"].includes(templateCategory);
    }).length,
  }), [categoryCounts, counts.favorites, templates]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const next = templates.filter((template) => {
      const templateCategory = getCategory(template);
      if (folder !== "archived" && template.isArchived) return false;
      if (folder === "archived" && !template.isArchived) return false;
      if (folder === "favorites" && !template.isFavorite) return false;
      if (folder === "recent" && !template.lastUsedAt) return false;
      if (folder === "drafts" && !template.isDraft) return false;
      if (category === "More" && ["Sales", "Follow-up", "Appointment", "Marketing"].includes(templateCategory)) return false;
      if (!["All", "All Templates", "More"].includes(category) && templateCategory !== category) return false;
      if (
        normalizedQuery &&
        !`${template.name} ${template.subject} ${template.previewText || ""} ${template.bodyText || ""} ${templateCategory}`
          .toLowerCase()
          .includes(normalizedQuery)
      ) {
        return false;
      }
      return true;
    });

    return [...next].sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "usage") return (b.usageCount || 0) - (a.usageCount || 0);
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    });
  }, [templates, folder, category, query, sortKey]);

  const previewHtml = useMemo(
    () => selectedEditor ? renderPreviewHtml(selectedEditor, branding, signature, false) : "",
    [selectedEditor, branding, signature],
  );
  const previewSubject = useMemo(
    () => selectedEditor ? renderCrmMergeTemplate(selectedEditor.subject, SAMPLE_VALUES) : "",
    [selectedEditor],
  );

  const openPreview = (template: Template) => {
    setSelectedId(template.id);
    setPreviewTab("preview");
  };

  const openComposer = (state: EditorState) => {
    setComposerState(state);
    setComposerOpen(true);
  };

  const newTemplate = () => {
    window.location.href = "/crm/email/templates/new";
  };

  const applyStarter = (starter: StarterTemplate) => {
    openComposer({
      ...emptyEditor(),
      name: starter.name,
      category: starter.category,
      subject: starter.subject,
      previewText: starter.previewText,
      bodyText: starter.bodyText,
      bodyHtml: starter.bodyHtml || plainTextToCrmHtml(starter.bodyText),
      isDraft: true,
    });
  };

  const saveComposer = async (draft: boolean) => {
    if (!composerState) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...composerState,
        isDraft: draft,
        bodyHtml: composerState.bodyHtml || plainTextToCrmHtml(composerState.bodyText),
      };
      let saved: Template;
      if (composerState.id) {
        saved = await apiPut<Template>(`/crm/email/templates/${composerState.id}`, payload as any);
      } else {
        saved = await apiPost<Template>("/crm/email/templates", payload as any);
      }
      setSelectedId(saved.id);
      setComposerOpen(false);
      setComposerState(null);
      setNotice(draft ? "Draft saved" : "Template saved");
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async (template = selectedTemplate) => {
    if (!template?.id) return;
    const copy = await apiPost<Template>(`/crm/email/templates/${template.id}/duplicate`);
    setNotice("Template duplicated");
    setSelectedId(copy.id);
    await load();
  };

  const archive = async (template = selectedTemplate) => {
    if (!template?.id) return;
    if (!confirm("Archive this template? It will be hidden from the main library.")) return;
    await apiPost(`/crm/email/templates/${template.id}/archive`);
    setNotice("Template archived");
    if (selectedId === template.id) setSelectedId(null);
    await load();
  };

  const restore = async (template: Template) => {
    await apiPut(`/crm/email/templates/${template.id}`, { isArchived: false });
    setNotice("Template restored");
    await load();
  };

  const favorite = async (template: Template) => {
    await apiPut<Template>(`/crm/email/templates/${template.id}`, { isFavorite: !template.isFavorite });
    await load();
  };

  return (
    <PermissionGate permission="can_view_crm_email" fallback={<div className="state-box">You do not have CRM Email access.</div>}>
      <CRMPageShell innerClassName="mx-auto flex w-full max-w-[min(100%,1660px)] flex-col gap-5 px-3 py-4 sm:px-5 lg:px-7">
        <header className="overflow-hidden rounded-[2rem] border border-blue-100/80 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.18),transparent_34%),linear-gradient(135deg,#ffffff_0%,#f8fbff_48%,#f4f0ff_100%)] p-5 shadow-[0_24px_80px_-48px_rgba(30,64,175,0.9)] sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/80 px-3 py-1 text-[11px] font-black uppercase tracking-[0.24em] text-blue-700 shadow-sm">
                <Sparkles className="h-3.5 w-3.5" /> CRM EMAIL STUDIO
              </div>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">Email Templates</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
                Create, manage, and reuse email templates to save time and stay consistent.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-sm font-bold text-slate-500 shadow-sm" disabled title="Import is not available on this route yet">
                Import Template
              </button>
              <button type="button" className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-sm font-bold text-slate-500 shadow-sm" disabled title="Folder management is not available yet">
                <FolderOpen className="mr-2 inline h-4 w-4" /> Folders
              </button>
              <button type="button" className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2 text-sm font-black text-white shadow-[0_16px_34px_-18px_rgba(37,99,235,0.9)] transition hover:bg-blue-700" onClick={newTemplate}>
                <Plus className="h-4 w-4" /> New Template
              </button>
            </div>
          </div>
        </header>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">{notice}</div>}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Total Templates", value: counts.total, sub: `${filtered.length} shown`, icon: Mail, tone: "from-blue-500 to-violet-500", bg: "bg-blue-50", text: "text-blue-700" },
            { label: "Active Templates", value: counts.active, sub: "Ready to use", icon: Send, tone: "from-emerald-500 to-teal-500", bg: "bg-emerald-50", text: "text-emerald-700" },
            { label: "Drafts", value: counts.drafts, sub: "Needs review", icon: Edit3, tone: "from-amber-500 to-orange-500", bg: "bg-amber-50", text: "text-amber-700" },
            { label: "Archived", value: counts.archived, sub: "Hidden from library", icon: Archive, tone: "from-slate-500 to-slate-700", bg: "bg-slate-100", text: "text-slate-700" },
          ].map((stat) => (
            <article key={stat.label} className="relative overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.7)]">
              <div className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r", stat.tone)} />
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">{stat.label}</p>
                  <p className={cn("mt-3 text-3xl font-black tabular-nums", stat.text)}>{stat.value}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">{stat.sub}</p>
                </div>
                <div className={cn("flex h-12 w-12 items-center justify-center rounded-2xl", stat.bg, stat.text)}>
                  <stat.icon className="h-5 w-5" />
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-[1.75rem] border border-slate-200/80 bg-white/95 p-3 shadow-[0_18px_60px_-42px_rgba(15,23,42,0.8)]">
          <div className="flex gap-2 overflow-x-auto pb-2">
            {FEATURED_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={cn(
                  "shrink-0 rounded-full border px-4 py-2 text-sm font-bold transition",
                  category === tab || (category === "All" && tab === "All Templates")
                    ? "border-blue-200 bg-blue-600 text-white shadow-[0_12px_26px_-18px_rgba(37,99,235,0.8)]"
                    : "border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700",
                )}
                onClick={() => setCategory(tab === "All Templates" ? "All" : tab)}
              >
                {tab} <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs">{tabCounts[tab]}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_170px_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-10 pr-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100"
                placeholder="Search templates..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="relative block">
              <select className="h-11 w-full appearance-none rounded-2xl border border-slate-200 bg-slate-50 px-3 pr-9 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="All">All categories</option>
                {CRM_EMAIL_TEMPLATE_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                <option value="Marketing">Marketing</option>
                <option value="More">More</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </label>
            <label className="relative block">
              <select className="h-11 w-full appearance-none rounded-2xl border border-slate-200 bg-slate-50 px-3 pr-9 text-sm font-bold text-slate-700 outline-none transition focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
                <option value="updated">Last Modified</option>
                <option value="name">Name A-Z</option>
                <option value="usage">Most Used</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </label>
            <div className="flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
              <button type="button" className={cn("rounded-xl px-3 py-2 text-slate-500", viewMode === "grid" && "bg-white text-blue-700 shadow-sm")} onClick={() => setViewMode("grid")} title="Grid view">
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" className={cn("rounded-xl px-3 py-2 text-slate-500", viewMode === "list" && "bg-white text-blue-700 shadow-sm")} onClick={() => setViewMode("list")} title="List view">
                <Grid3X3 className="h-4 w-4 rotate-90" />
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {folders.map((item) => (
              <button
                key={item.key}
                type="button"
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-bold transition",
                  folder === item.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:text-blue-700",
                )}
                onClick={() => setFolder(item.key)}
              >
                {item.label} <span className="ml-1 opacity-70">{item.count}</span>
              </button>
            ))}
          </div>
        </section>

        <main>
          {loading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-72 animate-pulse rounded-[1.75rem] bg-slate-100" />)}
            </div>
          ) : filtered.length === 0 ? (
            <section className="rounded-[2rem] border border-dashed border-blue-200 bg-[linear-gradient(135deg,#ffffff,#f6f9ff)] p-8 text-center shadow-[0_24px_80px_-56px_rgba(37,99,235,0.75)]">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-blue-50 text-blue-600">
                <Inbox className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-2xl font-black text-slate-950">Build your first email template</h2>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
                Start from a proven structure, save it as a draft, and reuse it across CRM outreach.
              </p>
              <button type="button" className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-black text-white shadow-[0_16px_34px_-18px_rgba(37,99,235,0.9)]" onClick={newTemplate}>
                <Plus className="h-4 w-4" /> New Template
              </button>
              {starters.length > 0 && (
                <div className="mt-7 grid gap-3 text-left md:grid-cols-3">
                  {starters.slice(0, 3).map((starter, index) => (
                    <button key={starter.key} type="button" className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200" onClick={() => applyStarter(starter)}>
                      <span className={cn("inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br text-white", CATEGORY_ACCENTS[index % CATEGORY_ACCENTS.length])}>
                        <Wand2 className="h-4 w-4" />
                      </span>
                      <span className="mt-3 block text-sm font-black text-slate-900">{starter.name}</span>
                      <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">{starter.previewText || starter.subject}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <div className={cn(viewMode === "grid" ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3" : "grid gap-3")}>
              {filtered.map((template, index) => {
                const templateCategory = getCategory(template);
                const snippet = getSnippet(template);
                const accent = CATEGORY_ACCENTS[index % CATEGORY_ACCENTS.length];
                return (
                  <article
                    key={template.id}
                    className={cn(
                      "group relative overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_54px_-40px_rgba(15,23,42,0.9)] transition hover:-translate-y-1 hover:border-blue-200 hover:shadow-[0_24px_70px_-46px_rgba(37,99,235,0.95)]",
                      viewMode === "list" && "grid gap-4 md:grid-cols-[1fr_auto]",
                      template.isArchived && "border-dashed opacity-75",
                    )}
                  >
                    <div className="flex gap-3">
                      <button type="button" className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg", accent)} onClick={() => openPreview(template)}>
                        <FileText className="h-5 w-5" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openPreview(template)}>
                            <h3 className="truncate text-base font-black text-slate-950">{template.name}</h3>
                            <p className="mt-1 truncate text-xs font-semibold text-slate-500">{template.subject || "No subject yet"}</p>
                          </button>
                          <button type="button" className="rounded-full p-1 text-amber-400 transition hover:bg-amber-50" onClick={() => void favorite(template)} title="Favorite">
                            <Star className={cn("h-4 w-4", template.isFavorite && "fill-current")} />
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-blue-700">{templateCategory}</span>
                          {template.isDraft && <span className="rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-amber-700">Draft</span>}
                          {template.isArchived && <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-slate-600">Archived</span>}
                        </div>
                        <p className="mt-4 line-clamp-3 text-sm leading-6 text-slate-600">{snippet}</p>
                      </div>
                    </div>
                    <div className="mt-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <p className="font-black text-slate-900">{template.usageCount || 0}</p>
                        <p className="mt-0.5 text-slate-500">Uses</p>
                      </div>
                      <div className="rounded-2xl bg-blue-50 p-3">
                        <p className="font-black text-blue-700">N/A</p>
                        <p className="mt-0.5 text-slate-500">Open Rate</p>
                      </div>
                      <div className="rounded-2xl bg-emerald-50 p-3">
                        <p className="font-black text-emerald-700">N/A</p>
                        <p className="mt-0.5 text-slate-500">Reply Rate</p>
                      </div>
                      <div className="rounded-2xl bg-violet-50 p-3">
                        <p className="truncate font-black text-violet-700">{relativeTime(template.updatedAt)}</p>
                        <p className="mt-0.5 text-slate-500">Modified</p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                      <button type="button" className="inline-flex items-center gap-2 rounded-2xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 transition hover:bg-blue-100" onClick={() => openPreview(template)}>
                        <Eye className="h-4 w-4" /> Preview
                      </button>
                      <div className="flex items-center gap-1">
                        <button type="button" className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit" onClick={() => openComposer(editorFromTemplate(template))}>
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button type="button" className="rounded-xl p-2 text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="Duplicate" onClick={() => void duplicate(template)}>
                          <Copy className="h-4 w-4" />
                        </button>
                        {template.isArchived ? (
                          <button type="button" className="rounded-xl p-2 text-emerald-600 hover:bg-emerald-50" title="Restore" onClick={() => void restore(template)}>
                            <Archive className="h-4 w-4 rotate-180" />
                          </button>
                        ) : (
                          <button type="button" className="rounded-xl p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Archive" onClick={() => void archive(template)}>
                            <Archive className="h-4 w-4" />
                          </button>
                        )}
                        <button type="button" className="rounded-xl p-2 text-slate-300" title="More actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </main>

        {selectedTemplate && selectedEditor && (
          <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/30 backdrop-blur-sm" role="dialog" aria-modal="true">
            <button type="button" className="hidden flex-1 lg:block" aria-label="Close preview" onClick={() => setSelectedId(null)} />
            <aside className="flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl sm:max-w-xl lg:max-w-[520px]">
              <div className="border-b border-slate-200 bg-[linear-gradient(135deg,#ffffff,#f6f9ff)] p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600">Template Preview</p>
                    <h2 className="mt-2 text-2xl font-black text-slate-950">{selectedTemplate.name}</h2>
                    <p className="mt-1 text-sm text-slate-500">{selectedTemplate.subject || "No subject yet"}</p>
                  </div>
                  <button type="button" className="rounded-2xl border border-slate-200 bg-white p-2 text-slate-500 shadow-sm hover:text-slate-900" onClick={() => setSelectedId(null)}>
                    <PanelRightClose className="h-5 w-5" />
                  </button>
                </div>
                <div className="mt-4 flex gap-1 overflow-x-auto rounded-2xl bg-slate-100 p-1">
                  {(["preview", "details", "usage", "activity"] as const).map((tab) => (
                    <button key={tab} type="button" className={cn("shrink-0 rounded-xl px-3 py-2 text-xs font-black capitalize text-slate-500", previewTab === tab && "bg-white text-blue-700 shadow-sm")} onClick={() => setPreviewTab(tab)}>
                      {tab}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {previewTab === "preview" && (
                  <div className="space-y-4">
                    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">Subject</p>
                      <p className="mt-2 text-sm font-bold text-slate-900">{previewSubject || "No subject yet"}</p>
                    </div>
                    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-100">
                      <iframe title="Email template preview" className="h-[520px] w-full bg-white" srcDoc={previewHtml} />
                    </div>
                    <div>
                      <p className="text-xs font-black uppercase tracking-wide text-slate-400">Variables Used</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedVariables.length > 0 ? selectedVariables.map((token) => (
                          <span key={token} className="rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 text-xs font-bold text-violet-700">{token}</span>
                        )) : <span className="text-sm text-slate-500">No merge variables detected.</span>}
                      </div>
                    </div>
                  </div>
                )}
                {previewTab === "details" && (
                  <div className="grid gap-3">
                    {[
                      ["Category", getCategory(selectedTemplate)],
                      ["Visibility", selectedTemplate.visibility],
                      ["Status", selectedTemplate.isArchived ? "Archived" : selectedTemplate.isDraft ? "Draft" : "Active"],
                      ["Created", formatDate(selectedTemplate.createdAt)],
                      ["Last modified", formatDate(selectedTemplate.updatedAt)],
                      ["Attachments", `${selectedTemplate.attachments?.length || 0}`],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">{label}</p>
                        <p className="mt-1 text-sm font-bold text-slate-900">{value}</p>
                      </div>
                    ))}
                  </div>
                )}
                {previewTab === "usage" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl bg-blue-50 p-5">
                      <BarChart3 className="h-5 w-5 text-blue-700" />
                      <p className="mt-4 text-3xl font-black text-blue-700">{selectedTemplate.usageCount || 0}</p>
                      <p className="text-sm font-semibold text-slate-600">Total uses</p>
                    </div>
                    <div className="rounded-3xl bg-emerald-50 p-5">
                      <CalendarClock className="h-5 w-5 text-emerald-700" />
                      <p className="mt-4 text-lg font-black text-emerald-700">{relativeTime(selectedTemplate.lastUsedAt)}</p>
                      <p className="text-sm font-semibold text-slate-600">Last used</p>
                    </div>
                    <div className="rounded-3xl bg-slate-50 p-5 sm:col-span-2">
                      <p className="text-sm font-bold text-slate-900">Open and reply rates are not returned by the current templates API.</p>
                      <p className="mt-1 text-sm text-slate-500">The library shows those metrics honestly as unavailable instead of fabricating analytics.</p>
                    </div>
                  </div>
                )}
                {previewTab === "activity" && (
                  <div className="space-y-3">
                    <div className="rounded-3xl border border-slate-200 bg-white p-4">
                      <p className="text-sm font-black text-slate-900">Template updated</p>
                      <p className="mt-1 text-sm text-slate-500">{formatDate(selectedTemplate.updatedAt)}</p>
                    </div>
                    {selectedTemplate.lastUsedAt ? (
                      <div className="rounded-3xl border border-slate-200 bg-white p-4">
                        <p className="text-sm font-black text-slate-900">Last used</p>
                        <p className="mt-1 text-sm text-slate-500">{formatDate(selectedTemplate.lastUsedAt)}</p>
                      </div>
                    ) : (
                      <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">No usage activity yet.</div>
                    )}
                  </div>
                )}
              </div>
              <div className="border-t border-slate-200 bg-white p-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  <button type="button" className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-black text-slate-500" disabled title="Use Template is available from compose surfaces">
                    Use Template
                  </button>
                  <button type="button" className="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-black text-white" onClick={() => openComposer(selectedEditor)}>
                    Edit Template
                  </button>
                  <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700" onClick={() => void duplicate(selectedTemplate)}>
                    Duplicate
                  </button>
                  <button type="button" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-2 text-sm font-black text-red-700" onClick={() => void archive(selectedTemplate)}>
                    Archive Template
                  </button>
                </div>
              </div>
            </aside>
          </div>
        )}

        {composerOpen && composerState && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true">
            <section className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-t-[2rem] border border-slate-200 bg-white p-5 shadow-2xl sm:rounded-[2rem]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600">Template Details</p>
                  <h2 className="mt-2 text-2xl font-black text-slate-950">{composerState.id ? "Edit Template" : "New Template"}</h2>
                  <p className="mt-1 text-sm text-slate-500">Compact library editor for template metadata and copy.</p>
                </div>
                <button type="button" className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600" onClick={() => setComposerOpen(false)}>
                  Close
                </button>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-wide text-slate-400">Template name</span>
                  <input className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" value={composerState.name} onChange={(event) => setComposerState((cur) => cur ? { ...cur, name: event.target.value } : cur)} />
                </label>
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-wide text-slate-400">Category</span>
                  <select className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" value={composerState.category} onChange={(event) => setComposerState((cur) => cur ? { ...cur, category: event.target.value } : cur)}>
                    {CRM_EMAIL_TEMPLATE_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                    <option value="Marketing">Marketing</option>
                  </select>
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-black uppercase tracking-wide text-slate-400">Subject</span>
                  <input className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" value={composerState.subject} onChange={(event) => setComposerState((cur) => cur ? { ...cur, subject: event.target.value } : cur)} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-black uppercase tracking-wide text-slate-400">Preview text</span>
                  <input className="mt-2 h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" value={composerState.previewText} onChange={(event) => setComposerState((cur) => cur ? { ...cur, previewText: event.target.value } : cur)} />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-black uppercase tracking-wide text-slate-400">Body</span>
                  <textarea className="mt-2 min-h-52 w-full rounded-3xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800 outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" value={composerState.bodyText || stripHtml(composerState.bodyHtml)} onChange={(event) => setComposerState((cur) => cur ? { ...cur, bodyText: event.target.value, bodyHtml: plainTextToCrmHtml(event.target.value) } : cur)} />
                </label>
              </div>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button type="button" className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700" onClick={() => void saveComposer(true)} disabled={saving}>
                  Save Draft
                </button>
                <button type="button" className="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-black text-white" onClick={() => void saveComposer(false)} disabled={saving}>
                  {saving ? "Saving..." : "Save Template"}
                </button>
              </div>
            </section>
          </div>
        )}
      </CRMPageShell>
    </PermissionGate>
  );
}
