"use client";

import type { ChatThreadType } from "./types";

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

export function threadLabel(type?: ChatThreadType | string): string {
  if (type === "SMS") return "SMS";
  if (type === "TENANT_GROUP") return "Tenant";
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
