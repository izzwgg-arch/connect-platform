"use client";

import { Eye, Moon, Paperclip, Smartphone, Sun, Monitor } from "lucide-react";
import { cn } from "../../cn";
import { formatBytes } from "./helpers";
import type { Attachment } from "./types";

export function EmailPreviewPanel({
  html,
  subject,
  previewText,
  senderName,
  senderEmail,
  attachments,
  previewMode,
  colorMode,
  onPreviewModeChange,
  onColorModeChange,
}: {
  html: string;
  subject: string;
  previewText: string;
  senderName: string;
  senderEmail: string;
  attachments: Attachment[];
  previewMode: "desktop" | "mobile";
  colorMode: "light" | "dark";
  onPreviewModeChange: (mode: "desktop" | "mobile") => void;
  onColorModeChange: (mode: "light" | "dark") => void;
}) {
  return (
    <aside className="email-builder-panel flex min-h-[34rem] flex-col overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white shadow-[0_18px_60px_-42px_rgba(15,23,42,0.8)]">
      <div className="border-b border-slate-100 bg-gradient-to-b from-white to-slate-50/80 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-950">
            <Eye className="h-4 w-4 text-blue-600" /> Live Preview
          </div>
          <div className="flex items-center gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            <button type="button" onClick={() => onPreviewModeChange("desktop")} className={cn("rounded-xl p-1.5", previewMode === "desktop" ? "bg-blue-50 text-blue-600" : "text-slate-400")}>
              <Monitor className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => onPreviewModeChange("mobile")} className={cn("rounded-xl p-1.5", previewMode === "mobile" ? "bg-blue-50 text-blue-600" : "text-slate-400")}>
              <Smartphone className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => onColorModeChange(colorMode === "light" ? "dark" : "light")} className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700">
              {colorMode === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Inbox Preview</div>
          <div className="mt-2 flex items-start gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
              {(senderName || "C").slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-slate-900">{senderName || "Your Company"} <span className="font-normal text-slate-400">&lt;{senderEmail || "hello@yourcompany.com"}&gt;</span></div>
              <div className="truncate text-sm font-bold text-slate-950">{subject || "Preview subject line"}</div>
              <div className="truncate text-xs text-slate-500">{previewText || "Preview text appears here in the recipient inbox."}</div>
            </div>
          </div>
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-auto p-4", colorMode === "dark" ? "bg-slate-950" : "bg-slate-100")}>
        <div className={cn("mx-auto overflow-hidden rounded-[1.45rem] border shadow-2xl transition-all", previewMode === "mobile" ? "max-w-[270px]" : "max-w-full", colorMode === "dark" ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white")}>
          <iframe title="Email preview" className="h-[590px] w-full bg-white" srcDoc={html} />
        </div>
      </div>

      <div className="border-t border-slate-100 bg-white p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
          <Paperclip className="h-3.5 w-3.5" /> Attachments
        </div>
        {attachments.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">No files attached to this template.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <span key={a.id} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
                {a.originalFileName} · {formatBytes(a.sizeBytes)}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
