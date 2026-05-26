"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, Copy, MoreHorizontal, Square } from "lucide-react";
import { crm } from "../crmClasses";
import { cn } from "../cn";

interface ScriptSectionBlockProps {
  title: string;
  content: string;
  index: number;
  defaultOpen?: boolean;
  /** When true, render content as interactive checkboxes */
  checklistMode?: boolean;
  stepDone?: boolean;
  onStepDone?: (done: boolean) => void;
}

/** Parse content lines into structured items (bold headers + body paragraphs) */
function parseContentLines(content: string): { type: "header" | "body" | "bullet"; text: string }[] {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
        return { type: "header" as const, text: trimmed.replace(/^\*\*|\*\*$/g, "") };
      }
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        return { type: "bullet" as const, text: trimmed.replace(/^[-*]\s+/, "") };
      }
      return { type: "body" as const, text: trimmed };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export function ScriptSectionBlock({
  title,
  content,
  index,
  defaultOpen = true,
  checklistMode = false,
  stepDone = false,
  onStepDone,
}: ScriptSectionBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const [itemsDone, setItemsDone] = useState<Record<number, boolean>>({});

  const lines = parseContentLines(content);
  const sectionLabel = title || `Section ${index + 1}`;

  function handleCopy() {
    const text = title ? `${title}\n\n${content}` : content;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function toggleItem(i: number) {
    setItemsDone((prev) => {
      const updated = { ...prev, [i]: !prev[i] };
      const allDone = lines.every((_, idx) => updated[idx]);
      onStepDone?.(allDone);
      return updated;
    });
  }

  const bodyLineCount = lines.filter((l) => l.type === "body" || l.type === "bullet").length;
  const checkedCount = Object.values(itemsDone).filter(Boolean).length;
  const tone = ["lavender", "blue", "green", "amber", "rose"][index % 5];

  return (
    <div
      id={`section-${index}`}
      className={cn("group", crm.scriptSectionCard, `scripts-section-card--${tone}`, open && crm.scriptSectionCardOpen)}
    >
      {/* Section header */}
      <div className="flex items-center gap-3 px-4 py-4">
        {/* Step badge */}
        <span
          className={cn(
            "scripts-section-number flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold",
            checklistMode && stepDone
              ? "bg-crm-success text-white"
              : "bg-crm-surface border border-crm-border text-crm-muted",
          )}
        >
          {checklistMode && stepDone ? "✓" : index + 1}
        </span>

        <button
          type="button"
          className="flex min-w-0 flex-1 appearance-none items-center gap-2 border-0 bg-transparent p-0 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={cn(
              "truncate text-base font-bold",
              checklistMode && stepDone ? "text-crm-muted line-through" : "text-crm-text",
            )}
          >
            {sectionLabel}
          </span>
          {checklistMode && bodyLineCount > 0 ? (
            <span
              className={cn(
                "ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                checkedCount === bodyLineCount
                  ? "bg-crm-success/15 text-crm-success"
                  : "bg-crm-warning/15 text-crm-warning",
              )}
            >
              {checkedCount}/{bodyLineCount}
            </span>
          ) : null}
        </button>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            title="Copy section"
            onClick={handleCopy}
            className="flex h-8 w-8 appearance-none items-center justify-center rounded-xl border-0 bg-transparent p-0 text-crm-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-crm-surface hover:text-crm-text focus:opacity-100"
          >
            {copied ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-crm-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            title="Copy section"
            onClick={handleCopy}
            className="flex h-8 w-8 appearance-none items-center justify-center rounded-xl border-0 bg-transparent p-0 text-crm-muted hover:bg-crm-surface hover:text-crm-text"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex h-8 w-8 appearance-none items-center justify-center rounded-xl border-0 bg-transparent p-0 text-crm-muted hover:bg-crm-surface hover:text-crm-text"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                open ? "rotate-180" : "",
              )}
            />
          </button>
        </div>
      </div>

      {/* Section body */}
      {open ? (
        <div className="border-t border-crm-border/50 px-4 pb-5 pt-4">
          {checklistMode ? (
            <div className="flex flex-col gap-1.5">
              {lines.map((line, i) => {
                if (line.type === "header") {
                  return (
                    <p key={i} className="pt-1 text-xs font-bold uppercase tracking-wider text-crm-muted">
                      {line.text}
                    </p>
                  );
                }
                const done = !!itemsDone[i];
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleItem(i)}
                    className={cn(
                      crm.scriptCheckStep,
                      done ? crm.scriptCheckStepDone : crm.scriptCheckStepPending,
                    )}
                  >
                    {done ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-crm-success" />
                    ) : (
                      <Square className="mt-0.5 h-4 w-4 shrink-0 text-crm-muted" />
                    )}
                    <span className={cn("flex-1 leading-snug", line.type === "bullet" && "pl-1")}>
                      {line.text}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {lines.map((line, i) => {
                if (line.type === "header") {
                  return (
                    <p key={i} className="pt-1 text-xs font-bold uppercase tracking-wider text-crm-muted">
                      {line.text}
                    </p>
                  );
                }
                if (line.type === "bullet") {
                  return (
                    <div key={i} className="flex items-baseline gap-2 text-sm leading-relaxed text-crm-text">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-crm-accent/60" />
                      <span>{line.text}</span>
                    </div>
                  );
                }
                return (
                  <p key={i} className="text-sm leading-relaxed text-crm-text">
                    {line.text}
                  </p>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
