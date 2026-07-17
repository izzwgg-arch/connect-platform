"use client";

import type { ChatThreadType } from "./types";

// Shared avatar palette (mini dialer / mobile / portal): stable color per contact.
export const AVATAR_TONES = ["#22c55e", "#06b6d4", "#3b82f6", "#a78bfa", "#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6"];
export function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
export function isPhoneLabel(name: string): boolean {
  return !/[a-z]/i.test(name || "");
}
// "+18456627080" -> "845-662-7080" (strip +1, hyphenate); names pass through.
export function formatPhoneDisplay(raw: string): string {
  const s = raw || "";
  if (/[a-z]/i.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  return s.replace(/^\+1(?=\d)/, "");
}
// Row/header title: tenant group shows ONLY the tenant name; numbers lose the +1.
export function threadDisplayName(thread: { type?: ChatThreadType | string; participantName: string }): string {
  if (thread.type === "TENANT_GROUP") return thread.participantName.replace(/\s*[\u2014-]\s*Tenant Group Chat\s*$/i, "");
  return formatPhoneDisplay(thread.participantName);
}

export function fmtChatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (Number.isNaN(d.getTime())) return "";
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "CC";
}

export function smsInboxBadge(kind?: "shared" | "personal" | null): string | null {
  if (kind === "shared") return "Shared";
  if (kind === "personal") return "Personal";
  return null;
}

export function crmSmsBadge(enabled?: boolean): string | null {
  return enabled ? "CRM SMS" : null;
}

export function threadLabel(type?: ChatThreadType | string): string {
  if (type === "SMS") return "SMS";
  if (type === "TENANT_GROUP") return "Team chat";
  if (type === "GROUP") return "Group";
  if (type === "DM") return "DM";
  return "Chat";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function mapUrl(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${encodeURIComponent(`${lat},${lng}`)}`;
}
