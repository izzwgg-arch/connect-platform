import { isNavItemVisibleForUser, navItems, navSectionMeta } from "../navigation/navConfig";
import type { PortalNavVisibility } from "@connect/shared";
import type { Permission } from "../types/app";

export type SearchResult = { id: string; title: string; description: string; kind: "page" | "setting" | "record"; href?: string; personalSection?: "quick" | "voicemail"; navId?: string; keywords?: string; group?: string };

// Pages and access come from the live sidebar, never a second role catalog.
const aliases: Record<string, string> = {
  "workspace.overview": "dashboard home analytics statistics missed calls",
  "workspace.team": "people colleagues employees staff directory extensions phone numbers",
  "workspace.calls": "incoming outgoing missed calls history recordings recent calls",
  "workspace.voicemail": "voice mail messages mailbox recordings callback reminders",
  "workspace.chat": "text texts sms messages conversations inbox attachments",
  "workspace.contacts": "address book customers people telephone email directory",
  "workspace.meetings": "video conference conferencing zoom invite",
  "workspace.remote_desktop": "computer screen remote access connect id",
  "workspace.desk_phones": "deskphone provision provisioning handset serial mac fanvil poly grandstream",
  "pbx.extensions": "extension telephone handset caller id users sip",
  "pbx.ivr_routing": "ivr auto attendant phone menu greeting routing dialplan",
  "settings.email": "smtp mail sender delivery notification email server",
  "settings.messaging": "sms text routing message provider whatsapp",
  "settings.billing": "payment card credit autopay invoices billing address",
  "settings.system_health": "diagnostics microphone network connectivity audio troubleshooting",
  "admin.permissions": "permission access sidebar hide show sections user rights",
  "admin.roles": "custom roles permission access user rights owner",
  "admin.tenants": "companies organizations workspaces accounts customers",
  "admin.users": "users people login invite employee account extension assignment",
  "admin.deploy_center": "deployment release build update queue logs",
  "apps.sms_campaigns": "bulk sms text messages marketing campaigns",
  "billing.overview": "invoice invoices payments receipts balance subscription plan",
};

const personal = (id: string, title: string, description: string, section: "quick" | "voicemail", keywords: string): SearchResult => ({ id: `personal.${id}`, title, description: `Personal settings · ${description}`, kind: "setting", personalSection: section, keywords });
const setting = (id: string, title: string, tab: string, keywords: string): SearchResult => ({ id: `settings.${id}`, title, description: `Settings · ${title}`, kind: "setting", navId: "settings.tenant", href: `/settings#${tab}`, keywords });
const settings: SearchResult[] = [
  personal("dnd", "Do Not Disturb", "Extension call availability", "quick", "dnd silence stop ringing busy calls"),
  personal("theme", "Light / dark mode", "Appearance", "quick", "theme color colour appearance display light dark"),
  personal("ringer", "Incoming call sound", "Browser ringing and mute", "quick", "mute unmute browser ringer ringtone volume sound notification"),
  personal("sms_email", "Email my text messages", "SMS notifications", "quick", "sms text email forward notifications"),
  personal("voicemail_email", "Voicemail email and transcription", "Voicemail", "voicemail", "voice mail email transcript notification"),
  personal("greeting", "Voicemail greeting", "Record or upload a greeting", "voicemail", "voice mail audio wav mp3 announcement record upload greeting"),
  personal("profile", "Profile photo", "Your account", "quick", "avatar photo picture profile account"),
  { id: "personal.security", title: "Security & two-step verification", description: "Your account · Sign-in security", kind: "setting", href: "/account/security", keywords: "2fa mfa otp password login sign in authenticator security verification code" },
  setting("general", "General account settings", "general", "name language profile timezone mobile qr provision"),
  setting("forwarding", "Call forwarding", "call_forwarding", "forward divert redirect unanswered busy away timeout destination ring"),
  setting("audio", "Microphone, speaker & camera", "audio", "audio video input output device microphone mic camera speaker headset ringtone sound"),
  setting("greetings", "Greetings and announcements", "greetings", "voicemail greeting audio record announcement"),
  setting("blf", "BLF and speed dial", "blf", "busy lamp field favorites favourites speed dial monitor extensions"),
];

export function searchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}@+]+/gu, " ").trim();
}
export function searchScore(result: SearchResult, query: string): number {
  const q = searchText(query);
  if (!q) return 1;
  const title = searchText(result.title);
  const haystack = searchText(`${result.title} ${result.description} ${result.keywords ?? ""}`);
  if (!q.split(/\s+/).every(word => haystack.includes(word))) return 0;
  return title === q ? 100 : title.startsWith(q) ? 80 : title.includes(q) ? 60 : 20;
}
export function buildSearchCatalog(can: (key: Permission) => boolean, role: string | undefined, visibility?: PortalNavVisibility): SearchResult[] {
  const visible = navItems.filter(item => isNavItemVisibleForUser(item, can, role, visibility));
  const ids = new Set(visible.map(item => item.id));
  return [
    ...visible.filter(item => !item.download).map(item => ({ id: item.id, navId: item.id, title: item.label, description: `${navSectionMeta[item.section].label} · Page`, kind: "page" as const, href: item.href, keywords: `${item.href.replace(/[/?_-]/g, " ")} ${aliases[item.id] ?? ""}` })),
    ...settings.filter(item => !item.navId || ids.has(item.navId)),
  ];
}
export function findSearchResults(catalog: SearchResult[], query: string): SearchResult[] {
  return catalog.map(result => ({ result, score: searchScore(result, query) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title)).map(item => item.result);
}
export const OPEN_PERSONAL_SETTINGS_EVENT = "loopcom:open-personal-settings";
