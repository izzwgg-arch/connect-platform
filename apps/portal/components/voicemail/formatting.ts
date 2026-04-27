import type { VoicemailRow } from "./types";

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtListTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor((startToday - startMsg) / 86400000);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 0) return `Today ${t}`;
  if (diffDays === 1) return `Yesterday ${t}`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type DayGroup = "today" | "yesterday" | "earlier";

export function dayGroupFor(iso: string): DayGroup {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor((startToday - startMsg) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  return "earlier";
}

export function dayGroupLabel(g: DayGroup): string {
  if (g === "today") return "Today";
  if (g === "yesterday") return "Yesterday";
  return "Earlier";
}

export function callerInitials(vm: VoicemailRow): string {
  if (vm.callerName) {
    const parts = vm.callerName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
    return vm.callerName.slice(0, 2).toUpperCase();
  }
  const digits = vm.callerId.replace(/\D/g, "");
  return digits.length >= 2 ? digits.slice(-2) : "VM";
}

export function callerKind(vm: VoicemailRow): "internal" | "external" {
  const raw = vm.callerId.replace(/\D/g, "");
  if (raw.length > 0 && raw.length <= 4) return "internal";
  return "external";
}

export function previewText(vm: VoicemailRow): string | null {
  const t = vm.transcription?.trim();
  if (t) return t.length > 140 ? `${t.slice(0, 137)}…` : t;
  return null;
}
