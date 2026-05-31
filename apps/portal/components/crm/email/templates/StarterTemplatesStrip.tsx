"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { StarterTemplate } from "./types";

export function StarterTemplatesStrip({
  starters,
  onApply,
}: {
  starters: StarterTemplate[];
  onApply: (starter: StarterTemplate) => void;
}) {
  if (starters.length === 0) return null;
  return (
    <section className="email-builder-panel rounded-[1.75rem] border border-slate-200/80 bg-white p-4 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-950"><Sparkles className="h-4 w-4 text-blue-600" /> Starter Templates</h3>
          <p className="text-xs text-slate-500">Start with a polished flow and customize it.</p>
        </div>
        <Link href="/crm/email/settings" className="text-xs font-semibold text-blue-600">Email Settings</Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {starters.map((starter) => (
          <button key={starter.key} type="button" onClick={() => onApply(starter)} className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md">
            <p className="text-sm font-bold text-slate-950">{starter.name}</p>
            <p className="mt-1 text-xs text-slate-500">{starter.category}</p>
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-400">{starter.previewText}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
