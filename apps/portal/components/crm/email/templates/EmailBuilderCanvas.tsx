"use client";

import { EditorContent } from "@tiptap/react";
import {
  Archive,
  Bold,
  Copy,
  Image,
  Italic,
  Link as LinkIcon,
  Loader2,
  MoreHorizontal,
  Save,
  Send,
  Star,
  Trash2,
  Underline as UnderlineIcon,
} from "lucide-react";
import { CRM_EMAIL_MERGE_FIELDS, CRM_EMAIL_TEMPLATE_CATEGORIES } from "@connect/shared";
import { crm, cn } from "../..";
import type { BuilderBlock, BuilderEditor, EditorState, SaveState } from "./types";

export function EmailBuilderCanvas({
  editor,
  editorState,
  blocks,
  saving,
  saveState,
  onChange,
  onInsertBlock,
  onSaveDraft,
  onSaveTemplate,
  onSendTest,
  onDuplicate,
  onArchive,
  onDropBlock,
}: {
  editor: BuilderEditor;
  editorState: EditorState | null;
  blocks: BuilderBlock[];
  saving: boolean;
  saveState: SaveState;
  onChange: (patch: Partial<EditorState>) => void;
  onInsertBlock: (html: string) => void;
  onSaveDraft: () => void;
  onSaveTemplate: () => void;
  onSendTest: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDropBlock: (html: string) => void;
}) {
  if (!editorState) {
    return (
      <main className="email-builder-panel flex min-h-[34rem] items-center justify-center rounded-[1.75rem] border border-slate-200/80 bg-white p-10 text-center shadow-[0_18px_60px_-42px_rgba(15,23,42,0.8)]">
        <div>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-blue-50 text-blue-600">
            <Save className="h-7 w-7" />
          </div>
          <h2 className="mt-4 text-lg font-bold text-slate-950">Build your first email template</h2>
          <p className="mt-1 max-w-md text-sm text-slate-500">Choose a starter template or create a polished email from scratch.</p>
        </div>
      </main>
    );
  }

  const saveLabel =
    saveState === "autosaving" ? "Autosaving..." :
    saveState === "dirty" ? "Unsaved changes" :
    saveState === "saved" ? "Saved" : "Ready";
  const editorCommands = editor as any;

  return (
    <main className="email-builder-panel min-w-0 overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white shadow-[0_18px_60px_-42px_rgba(15,23,42,0.8)]">
      <div className="border-b border-slate-100 bg-gradient-to-b from-white to-slate-50/70 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-blue-600">Builder Workspace</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <span className={cn("h-2 w-2 rounded-full", saveState === "dirty" ? "bg-amber-400" : saveState === "autosaving" ? "animate-pulse bg-blue-500" : "bg-emerald-500")} />
              {saveLabel}
            </div>
          </div>
          <button
            type="button"
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition", editorState.isFavorite ? "border-amber-200 bg-amber-50 text-amber-600" : "border-slate-200 bg-white text-slate-500 hover:border-amber-200 hover:text-amber-500")}
            onClick={() => onChange({ isFavorite: !editorState.isFavorite })}
          >
            <Star className={cn("h-3.5 w-3.5", editorState.isFavorite && "fill-amber-400")} />
            Favorite
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_160px]">
          <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Template Name
            <input
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
              value={editorState.name}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </label>
          <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Category
            <select
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm normal-case tracking-normal text-slate-900 outline-none transition focus:border-blue-300"
              value={editorState.category}
              onChange={(e) => onChange({ category: e.target.value })}
            >
              {CRM_EMAIL_TEMPLATE_CATEGORIES.map((cat) => <option key={cat}>{cat}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Visibility
            <select
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm normal-case tracking-normal text-slate-900 outline-none"
              value={editorState.visibility}
              onChange={(e) => onChange({ visibility: e.target.value as "SHARED" | "PRIVATE" })}
            >
              <option value="SHARED">Shared</option>
              <option value="PRIVATE">Private</option>
            </select>
          </label>
          <label className="lg:col-span-3 text-xs font-bold uppercase tracking-wide text-slate-500">
            Subject Line
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              <input
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm normal-case tracking-normal text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
                value={editorState.subject}
                onChange={(e) => onChange({ subject: e.target.value })}
              />
              <button type="button" className={cn(crm.btnSecondary, "shrink-0 bg-white text-xs")} onClick={() => editor?.chain().focus().insertContent(CRM_EMAIL_MERGE_FIELDS[0].token).run()}>
                Insert Merge Field
              </button>
            </div>
          </label>
          <label className="lg:col-span-3 text-xs font-bold uppercase tracking-wide text-slate-500">
            Preview Text
            <input
              className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm normal-case tracking-normal text-slate-900 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
              value={editorState.previewText}
              onChange={(e) => onChange({ previewText: e.target.value })}
            />
          </label>
        </div>
      </div>

      <div className="grid min-h-[34rem] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_104px]">
        <section className="min-w-0 p-3 sm:p-4">
          <div className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-100/70">
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white/95 px-3 py-2 text-slate-600">
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().undo().run()}>↶</button>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().redo().run()}>↷</button>
              <select className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium">
                <option>Paragraph</option>
              </select>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></button>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></button>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => editorCommands?.chain().focus().toggleUnderline().run()}><UnderlineIcon className="h-4 w-4" /></button>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => {
                const url = prompt("Enter a URL");
                if (url) editorCommands?.chain().focus().setLink({ href: url }).run();
              }}><LinkIcon className="h-4 w-4" /></button>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100" onClick={() => {
                const url = prompt("Enter an image URL");
                if (url) editorCommands?.chain().focus().setImage({ src: url }).run();
              }}><Image className="h-4 w-4" /></button>
              <button type="button" className="rounded-xl p-2 transition hover:bg-slate-100"><MoreHorizontal className="h-4 w-4" /></button>
            </div>
            <div
              className="bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.08),transparent_38%),linear-gradient(180deg,#f8fafc,#eef2ff)] px-3 py-5 sm:px-6"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const html = e.dataTransfer.getData("text/html");
                if (html) onDropBlock(html);
              }}
            >
              <div className="mx-auto max-w-[760px] overflow-hidden rounded-[1.35rem] bg-white shadow-[0_24px_70px_-42px_rgba(15,23,42,0.95)] ring-1 ring-slate-200/80">
                <EditorContent editor={editor} />
              </div>
            </div>
          </div>
          <div
            className="mt-3 flex items-center justify-center rounded-[1.35rem] border border-dashed border-blue-200 bg-blue-50/60 py-3 text-xs font-medium text-blue-700"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const html = e.dataTransfer.getData("text/html");
              if (html) onDropBlock(html);
            }}
          >
            Drop a block here, or choose one from the rail
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={crm.btnSecondary} onClick={onSaveDraft} disabled={saving}><Save className="h-4 w-4" /> Save Draft</button>
            <button type="button" className={crm.btnSecondary} onClick={onSendTest}><Send className="h-4 w-4" /> Send Test</button>
            <button type="button" className={crm.btnSecondary} onClick={onDuplicate} disabled={!editorState.id}><Copy className="h-4 w-4" /> Duplicate</button>
            <button type="button" className={crm.btnSecondary} onClick={onArchive} disabled={!editorState.id}><Archive className="h-4 w-4" /> Archive</button>
            <button type="button" className="inline-flex items-center gap-2 rounded-crm border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600" onClick={onArchive} disabled={!editorState.id}><Trash2 className="h-4 w-4" /> Delete</button>
            <button type="button" className={crm.btnPrimary} onClick={onSaveTemplate} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Template</button>
          </div>
        </section>

        <aside className="border-t border-slate-100 bg-slate-50/80 p-2 lg:border-l lg:border-t-0">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-1">
            {blocks.map((block) => {
              const Icon = block.icon;
              return (
                <button
                  key={block.label}
                  type="button"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/html", block.html)}
                  onClick={() => onInsertBlock(block.html)}
                  className="group flex min-h-[4.6rem] flex-col items-center justify-center gap-1 rounded-2xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-semibold text-slate-600 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:text-blue-600 hover:shadow-md"
                >
                  <Icon className="h-4 w-4 transition group-hover:scale-110" />
                  <span>{block.label}</span>
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}
