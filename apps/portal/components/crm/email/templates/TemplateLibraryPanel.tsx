"use client";

import {
  Archive,
  Copy,
  Edit3,
  Filter,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { CRM_EMAIL_TEMPLATE_CATEGORIES } from "@connect/shared";
import { cn } from "../../cn";
import { relativeTime } from "./helpers";
import type { Template, TemplateFolder } from "./types";

export function TemplateLibraryPanel({
  templates,
  filtered,
  selectedId,
  loading,
  query,
  category,
  folder,
  folders,
  onQueryChange,
  onCategoryChange,
  onFolderChange,
  onOpen,
  onFavorite,
  onDuplicate,
  onArchive,
  onRestore,
  onRename,
}: {
  templates: Template[];
  filtered: Template[];
  selectedId: string | null;
  loading: boolean;
  query: string;
  category: string;
  folder: string;
  folders: TemplateFolder[];
  onQueryChange: (query: string) => void;
  onCategoryChange: (category: string) => void;
  onFolderChange: (folder: TemplateFolder["key"]) => void;
  onOpen: (template: Template) => void;
  onFavorite: (template: Template) => void;
  onDuplicate: (template: Template) => void;
  onArchive: (template: Template) => void;
  onRestore: (template: Template) => void;
  onRename: (template: Template) => void;
}) {
  return (
    <aside className="email-builder-panel flex min-h-[26rem] flex-col overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white/95 shadow-[0_18px_60px_-40px_rgba(15,23,42,0.8)] backdrop-blur">
      <div className="border-b border-slate-100 bg-gradient-to-b from-white to-slate-50/80 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              className="w-full rounded-2xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
              placeholder="Search templates..."
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
          </div>
          <button
            className="rounded-2xl border border-slate-200 bg-white p-2 text-slate-500 shadow-sm transition hover:border-blue-200 hover:text-blue-600"
            type="button"
            title="Filters"
          >
            <Filter className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-1.5">
          {folders.map((f) => (
            <button
              key={f.key}
              type="button"
              className={cn(
                "rounded-2xl border px-3 py-2 text-left text-xs transition",
                folder === f.key
                  ? "border-blue-200 bg-blue-50 text-blue-700 shadow-sm"
                  : "border-transparent bg-slate-50 text-slate-600 hover:border-slate-200 hover:bg-white",
              )}
              onClick={() => onFolderChange(f.key)}
            >
              <span className="block font-semibold">{f.label}</span>
              <span className="mt-0.5 block text-[11px] opacity-70">{f.count} templates</span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Categories</div>
          <div className="text-[11px] text-slate-400">{filtered.length} shown</div>
        </div>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {["All", ...CRM_EMAIL_TEMPLATE_CATEGORIES].map((cat) => (
            <button
              key={cat}
              type="button"
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                category === cat
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-600",
              )}
              onClick={() => onCategoryChange(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          {loading ? (
            Array.from({ length: 5 }).map((_, idx) => (
              <div key={idx} className="h-[5.25rem] animate-pulse rounded-3xl bg-slate-100" />
            ))
          ) : filtered.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-slate-300 shadow-sm">
                <Search className="h-5 w-5" />
              </div>
              <p className="mt-3 text-sm font-semibold text-slate-800">No templates found</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">Try a different category, search, or archived filter.</p>
            </div>
          ) : filtered.map((t) => (
            <article
              key={t.id}
              className={cn(
                "group rounded-3xl border bg-white p-2.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-[0_18px_42px_-28px_rgba(37,99,235,0.65)]",
                selectedId === t.id ? "border-blue-300 bg-blue-50/70 ring-4 ring-blue-100" : "border-slate-200",
                t.isArchived && "border-dashed opacity-75",
              )}
            >
              <button type="button" className="flex w-full gap-3 text-left" onClick={() => onOpen(t)}>
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-blue-50 via-white to-indigo-50 p-2">
                  <div className="h-2 w-8 rounded-full bg-blue-500" />
                  <div className="mt-2 h-1.5 rounded-full bg-slate-300" />
                  <div className="mt-1.5 h-1.5 w-9 rounded-full bg-slate-200" />
                  <div className="absolute bottom-2 right-2 h-4 w-4 rounded-full bg-blue-100" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-950">{t.name}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">{t.subject || "No subject yet"}</p>
                    </div>
                    {t.isFavorite ? <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-400" /> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">{t.category || "Custom"}</span>
                    <span>{t.usageCount || 0} uses</span>
                    <span>Updated {relativeTime(t.updatedAt)}</span>
                  </div>
                </div>
              </button>
              <div className="mt-2 flex items-center justify-end gap-1 border-t border-slate-100 pt-2 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100">
                <button type="button" title="Favorite" className="rounded-xl p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-500" onClick={() => onFavorite(t)}>
                  <Star className={cn("h-3.5 w-3.5", t.isFavorite && "fill-amber-400 text-amber-400")} />
                </button>
                <button type="button" title="Rename" className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => onRename(t)}>
                  <Edit3 className="h-3.5 w-3.5" />
                </button>
                <button type="button" title="Duplicate" className="rounded-xl p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600" onClick={() => onDuplicate(t)}>
                  <Copy className="h-3.5 w-3.5" />
                </button>
                {t.isArchived ? (
                  <button type="button" title="Restore" className="rounded-xl p-1.5 text-emerald-600 hover:bg-emerald-50" onClick={() => onRestore(t)}>
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button type="button" title="Archive" className="rounded-xl p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => onArchive(t)}>
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                )}
                <Trash2 className="hidden h-3.5 w-3.5 text-slate-200" />
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-100 bg-slate-50/70 p-3">
        <button type="button" className="w-full rounded-2xl border border-slate-200 bg-white py-2 text-sm font-semibold text-blue-600 shadow-sm transition hover:border-blue-200 hover:bg-blue-50">
          + New Folder
        </button>
      </div>
    </aside>
  );
}
