"use client";

import {
  Bot,
  Clipboard,
  ExternalLink,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  ImagePlus,
  Paperclip,
  Replace,
  Search,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { cn } from "../../cn";
import { formatBytes } from "./helpers";
import type { Attachment, UtilityPanelProps } from "./types";

function fileIcon(attachment: Attachment) {
  const mime = attachment.mimeType || "";
  if (mime.includes("image")) return FileImage;
  if (mime.includes("spreadsheet") || mime.includes("csv")) return FileSpreadsheet;
  if (mime.includes("zip")) return FileArchive;
  if (mime.includes("pdf") || mime.includes("word")) return FileText;
  return File;
}

export function UtilityPanels(props: UtilityPanelProps) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.05fr_1fr_1fr_1.35fr]">
      <section className="email-builder-panel rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-950">Branding</h3>
            <p className="text-xs text-slate-500">Live-updates the email preview.</p>
          </div>
          <button className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-600" onClick={props.onSaveBranding}>Save</button>
        </div>
        <div
          className="mb-3 rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) props.onLogoUpload(file);
          }}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-white text-blue-600 shadow-sm">
              {props.branding.logoUrl ? <img src={props.branding.logoUrl} alt="" className="h-full w-full object-contain" /> : <ImagePlus className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">Business logo</p>
              <p className="text-xs text-slate-500">Drop image, upload, crop externally, then replace.</p>
            </div>
            <label className="cursor-pointer rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-200 hover:text-blue-600">
              Replace
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) props.onLogoUpload(file);
                e.currentTarget.value = "";
              }} />
            </label>
            <button type="button" className="rounded-xl p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={props.onLogoRemove}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {[
            ["businessName", "Business name", props.branding.businessName || ""],
            ["phone", "Phone", props.branding.phone || ""],
            ["website", "Website", props.branding.website || ""],
            ["address", "Address", props.branding.address || ""],
          ].map(([key, label, value]) => (
            <label key={key} className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
              {label}
              <input className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm normal-case tracking-normal text-slate-800 outline-none focus:border-blue-300" value={value} onChange={(e) => props.onBrandingChange({ ...props.branding, [key]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Sender Identity</h4>
            <p className="text-xs text-slate-500">Used by signatures and preview sender details.</p>
          </div>
          <button className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-bold text-slate-600 hover:border-blue-200 hover:text-blue-600" onClick={props.onSaveSignature}>Save sender</button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {[
            ["senderName", "Sender name", props.signature.senderName || ""],
            ["senderTitle", "Sender title", props.signature.senderTitle || ""],
            ["phone", "Sender phone", props.signature.phone || ""],
            ["email", "Sender email", props.signature.email || ""],
          ].map(([key, label, value]) => (
            <label key={key} className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
              {label}
              <input className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm normal-case tracking-normal text-slate-800 outline-none focus:border-blue-300" value={value} onChange={(e) => props.onSignatureChange({ ...props.signature, [key]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-500">
          Footer preview: {props.branding.businessName || "Your Company"} · {props.branding.address || "Business address"} · Privacy / unsubscribe links
        </div>
      </section>

      <section
        className="email-builder-panel rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) props.onAttachmentUpload(file);
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-950">Attachments</h3>
            <p className="text-xs text-slate-500">Drag files here or upload.</p>
          </div>
          <label className="cursor-pointer rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-600">
            Add Files
            <input type="file" className="hidden" onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onAttachmentUpload(file);
              e.currentTarget.value = "";
            }} />
          </label>
        </div>
        <div className={cn("mb-3 rounded-3xl border border-dashed p-4 text-center", props.uploadProgress != null ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50")}>
          <UploadCloud className="mx-auto h-6 w-6 text-blue-500" />
          <p className="mt-2 text-xs font-semibold text-slate-700">{props.uploadProgress != null ? `Uploading ${props.uploadProgress}%` : "PDF, DOCX, XLSX, CSV, images, ZIP"}</p>
        </div>
        <div className="space-y-2">
          {props.attachments.length === 0 ? (
            <p className="rounded-2xl border border-slate-100 bg-white px-3 py-3 text-center text-xs text-slate-500">No template attachments yet.</p>
          ) : props.attachments.map((a) => {
            const Icon = fileIcon(a);
            return (
              <div key={a.id} className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white px-3 py-2 text-sm shadow-sm">
                <Icon className="h-4 w-4 shrink-0 text-blue-600" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-slate-800">{a.originalFileName}</p>
                  <p className="text-xs text-slate-400">{formatBytes(a.sizeBytes)}</p>
                </div>
                <button title="Replace" className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100"><Replace className="h-3.5 w-3.5" /></button>
                <button title="Download not available in this UI-only pass" className="rounded-xl p-1.5 text-slate-300"><ExternalLink className="h-3.5 w-3.5" /></button>
                <button title="Remove" onClick={() => props.onAttachmentRemove(a.id)} className="rounded-xl p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="email-builder-panel rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]">
        <h3 className="text-sm font-bold text-slate-950">Merge Fields</h3>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input className="w-full rounded-2xl border border-slate-200 px-3 py-2 pl-9 text-sm outline-none focus:border-blue-300" placeholder="Search fields..." value={props.fieldQuery} onChange={(e) => props.onMergeQueryChange(e.target.value)} />
        </div>
        <div className="mt-3 max-h-64 overflow-y-auto pr-1">
          {Object.entries(props.fieldGroups).map(([group, fields]) => (
            <div key={group} className="mb-4">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{group === "User/Sender" ? "User" : group === "CRM" ? "System" : group}</div>
              <div className="space-y-1.5">
                {fields.map((field) => (
                  <div key={field.token} className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-slate-800">{field.label}</p>
                      <p className="truncate text-[11px] text-slate-400">{field.sample || field.token}</p>
                    </div>
                    <button title="Copy token" onClick={() => props.onCopyField(field)} className="rounded-xl p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"><Clipboard className="h-3.5 w-3.5" /></button>
                    <button title="Insert token" onClick={() => props.onInsertField(field)} className="rounded-xl bg-blue-600 px-2 py-1 text-[11px] font-bold text-white">Insert</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="email-builder-panel rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-950"><Bot className="h-4 w-4 text-blue-600" /> AI Assistant</h3>
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-600">OpenAI</span>
        </div>
        <textarea className="h-24 w-full resize-none rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300" placeholder="Ask AI to write, rewrite, shorten, or generate subject lines..." value={props.aiPrompt} onChange={(e) => props.onAiPromptChange(e.target.value)} />
        <div className="mt-3 grid grid-cols-2 gap-2">
          {["Generate complete email", "Rewrite selected section", "Shorten", "Expand", "Professional", "Friendly", "Follow-up", "Sales", "Support", "Appointment reminder", "Reactivate lead", "Generate subject lines"].map((action) => (
            <button key={action} type="button" className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600" onClick={() => props.onRunAi(action)}>{action}</button>
          ))}
        </div>
      </section>
    </div>
  );
}
