import {
  buildCrmEmailHtmlDocument,
  buildCrmEmailSignatureHtml,
  htmlToCrmPlainText,
  plainTextToCrmHtml,
  renderCrmMergeTemplate,
  type CrmEmailBrandingInput,
  type CrmEmailSignatureInput,
} from "@connect/shared";
import type { EditorState, Template } from "./types";

export const SAMPLE_VALUES: Record<string, string> = {
  "contact.firstName": "Alex",
  "contact.lastName": "Morgan",
  "contact.fullName": "Alex Morgan",
  "contact.name": "Alex Morgan",
  "contact.displayName": "Alex Morgan",
  "contact.email": "alex@example.com",
  "contact.phone": "(555) 123-4567",
  "contact.mobile": "(555) 987-6543",
  "contact.company": "Connect Communications",
  "contact.address": "123 Main Street",
  "contact.city": "New York",
  "contact.state": "NY",
  "contact.zipCode": "10001",
  "contact.timezone": "Eastern",
  "company.name": "Connect Communications",
  "crm.assignedAgent": "John Smith",
  "crm.assignedManager": "Jane Manager",
  "crm.campaignName": "Spring Outreach",
  "crm.leadSource": "Website",
  "crm.leadStatus": "New Lead",
  "crm.lastContactDate": "May 31, 2026",
  "business.name": "Your Company",
  "business.phone": "(845) 723-1213",
  "business.email": "info@yourcompany.com",
  "business.website": "www.yourcompany.com",
  "business.address": "123 Main Street, Suite 100, New York, NY 10001",
  "business.logo": "",
  "sender.name": "John Smith",
  "sender.email": "john.smith@yourcompany.com",
  "sender.phone": "(845) 723-1213",
  "sender.title": "Sales Manager",
  "sender.signature": "",
};

export function emptyEditor(): EditorState {
  return {
    name: "Untitled Template",
    subject: "",
    previewText: "",
    bodyText: "",
    bodyHtml: "<p>Hi {{contact.firstName}},</p><p>Write your email here.</p><p>{{sender.signature}}</p>",
    category: "Custom",
    isFavorite: false,
    isDraft: true,
    visibility: "SHARED",
  };
}

export function editorFromTemplate(t: Template): EditorState {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject,
    previewText: t.previewText || "",
    bodyText: t.bodyText || htmlToCrmPlainText(t.bodyHtml || ""),
    bodyHtml: t.bodyHtml || plainTextToCrmHtml(t.bodyText || ""),
    category: t.category || "Custom",
    isFavorite: Boolean(t.isFavorite),
    isDraft: Boolean(t.isDraft),
    visibility: t.visibility,
  };
}

export function formatBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function relativeTime(input?: string | null): string {
  if (!input) return "Never used";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "Recently";
  const diff = Date.now() - date.getTime();
  const mins = Math.max(1, Math.round(diff / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function renderPreviewHtml(
  editor: EditorState,
  branding: CrmEmailBrandingInput,
  signature: CrmEmailSignatureInput,
  dark = false,
): string {
  const vars = {
    ...SAMPLE_VALUES,
    "business.name": branding.businessName || SAMPLE_VALUES["business.name"],
    "business.phone": branding.phone || SAMPLE_VALUES["business.phone"],
    "business.email": branding.email || SAMPLE_VALUES["business.email"],
    "business.website": branding.website || SAMPLE_VALUES["business.website"],
    "business.address": branding.address || SAMPLE_VALUES["business.address"],
    "sender.name": signature.senderName || SAMPLE_VALUES["sender.name"],
    "sender.title": signature.senderTitle || SAMPLE_VALUES["sender.title"],
    "sender.email": signature.email || SAMPLE_VALUES["sender.email"],
    "sender.phone": signature.phone || SAMPLE_VALUES["sender.phone"],
    "sender.signature": buildCrmEmailSignatureHtml(signature),
  };
  const contentHtml = renderCrmMergeTemplate(editor.bodyHtml || plainTextToCrmHtml(editor.bodyText), vars);
  const html = buildCrmEmailHtmlDocument({
    subject: renderCrmMergeTemplate(editor.subject, vars),
    previewText: renderCrmMergeTemplate(editor.previewText, vars),
    contentHtml,
    branding,
    signature,
  });
  if (!dark) return html;
  return html
    .replace(/background:#f4f7fb/g, "background:#0f172a")
    .replace(/background:#ffffff/g, "background:#111827")
    .replace(/color:#111827/g, "color:#f8fafc")
    .replace(/background:#f8fafc/g, "background:#020617")
    .replace(/color:#6b7280/g, "color:#94a3b8")
    .replace(/border:1px solid #e5e7eb/g, "border:1px solid #334155");
}
