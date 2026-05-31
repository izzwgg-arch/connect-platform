import { db } from "@connect/db";
import {
  buildCrmEmailHtmlDocument,
  CRM_EMAIL_MERGE_FIELDS,
  CRM_EMAIL_SAMPLE_MERGE_VALUES,
  htmlToCrmPlainText,
  plainTextToCrmHtml,
  renderCrmMergeTemplate,
  type CrmEmailBrandingInput,
  type CrmEmailSignatureInput,
} from "@connect/shared";
import { resolveCrmEmailBranding, resolveCrmEmailSignature } from "./emailTemplateBranding";

export type CrmEmailTemplateLike = {
  id?: string;
  tenantId?: string;
  subject?: string | null;
  previewText?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  bodyJson?: unknown;
};

export type RenderedCrmEmailTemplate = {
  subject: string;
  previewText: string;
  html: string;
  text: string;
  vars: Record<string, string>;
};

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function normalizeCrmEmailCategory(input: unknown): string {
  const s = String(input || "Custom").trim();
  const known = ["Sales", "Follow-up", "Appointment", "Welcome", "Renewal", "Collections", "Custom"];
  return known.includes(s) ? s : "Custom";
}

export function extractPlainTextFromTemplate(template: CrmEmailTemplateLike): string {
  if (template.bodyText) return String(template.bodyText);
  if (template.bodyHtml) return htmlToCrmPlainText(String(template.bodyHtml));
  return "";
}

export function resolveTemplateContentHtml(template: CrmEmailTemplateLike): string {
  if (template.bodyHtml) return String(template.bodyHtml);
  return plainTextToCrmHtml(template.bodyText || "");
}

export async function buildCrmEmailMergeVars(input: {
  tenantId: string;
  userId: string;
  contactId?: string | null;
  toEmail?: string | null;
  sender?: { emailAddress?: string | null; senderName?: string | null; displayName?: string | null } | null;
  branding?: CrmEmailBrandingInput | null;
  signature?: CrmEmailSignatureInput | null;
  campaignName?: string | null;
}): Promise<Record<string, string>> {
  const contact = input.contactId
    ? await (db as any).contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          company: true,
          title: true,
          source: true,
          emails: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1, select: { email: true } },
          phones: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 2, select: { numberRaw: true, type: true } },
          addresses: { orderBy: [{ createdAt: "asc" }], take: 1, select: { street: true, city: true, state: true, zip: true, country: true } },
          crmMeta: {
            select: {
              stage: true,
              lastActivityAt: true,
              timezoneLabel: true,
              timezoneIana: true,
              assignedTo: { select: { name: true, email: true } },
            },
          },
        },
      }).catch(() => null)
    : null;

  const tenant = await (db as any).tenant.findUnique({
    where: { id: input.tenantId },
    select: { name: true },
  }).catch(() => null);
  const senderUser = await (db as any).user.findFirst({
    where: { id: input.userId, tenantId: input.tenantId },
    select: { name: true, email: true },
  }).catch(() => null);

  const branding = input.branding || await resolveCrmEmailBranding(input.tenantId, tenant?.name);
  const signature = input.signature || await resolveCrmEmailSignature({
    tenantId: input.tenantId,
    userId: input.userId,
    fallbackName: input.sender?.senderName || input.sender?.displayName || senderUser?.name,
    fallbackEmail: input.sender?.emailAddress || senderUser?.email,
    fallbackCompany: branding.businessName || tenant?.name,
  });
  const primaryEmail = contact?.emails?.[0]?.email || input.toEmail || "";
  const primaryPhone = contact?.phones?.find((p: any) => p.type !== "MOBILE")?.numberRaw || contact?.phones?.[0]?.numberRaw || "";
  const mobile = contact?.phones?.find((p: any) => p.type === "MOBILE")?.numberRaw || primaryPhone;
  const address = contact?.addresses?.[0] || null;
  const addressLine = address ? [address.street, address.city, address.state, address.zip].filter(Boolean).join(", ") : "";
  const firstName = contact?.firstName || (contact?.displayName ? String(contact.displayName).split(" ")[0] : "");
  const lastName = contact?.lastName || (contact?.displayName ? String(contact.displayName).split(" ").slice(1).join(" ") : "");
  const fullName = contact?.displayName || [firstName, lastName].filter(Boolean).join(" ");
  const vars: Record<string, string> = {
    ...CRM_EMAIL_SAMPLE_MERGE_VALUES,
    "contact.firstName": firstName,
    "contact.lastName": lastName,
    "contact.fullName": fullName,
    "contact.name": fullName,
    "contact.displayName": fullName,
    "contact.email": primaryEmail,
    "contact.phone": primaryPhone,
    "contact.mobile": mobile,
    "contact.company": contact?.company || "",
    "contact.address": addressLine,
    "contact.city": address?.city || "",
    "contact.state": address?.state || "",
    "contact.zipCode": address?.zip || "",
    "contact.timezone": contact?.crmMeta?.timezoneLabel || contact?.crmMeta?.timezoneIana || "",
    "company.name": contact?.company || "",
    "crm.assignedAgent": contact?.crmMeta?.assignedTo?.name || contact?.crmMeta?.assignedTo?.email || "",
    "crm.assignedManager": "",
    "crm.campaignName": input.campaignName || "",
    "crm.leadSource": String(contact?.source || ""),
    "crm.leadStatus": String(contact?.crmMeta?.stage || ""),
    "crm.lastContactDate": fmtDate(contact?.crmMeta?.lastActivityAt),
    "business.name": branding.businessName || tenant?.name || "",
    "business.phone": branding.phone || "",
    "business.email": branding.email || "",
    "business.website": branding.website || "",
    "business.address": branding.address || "",
    "business.logo": branding.logoUrl || "",
    "sender.name": signature.senderName || input.sender?.senderName || input.sender?.displayName || senderUser?.name || "",
    "sender.email": signature.email || input.sender?.emailAddress || senderUser?.email || "",
    "sender.phone": signature.phone || "",
    "sender.title": signature.senderTitle || "",
    "sender.signature": "",
  };
  vars.firstName = vars["contact.firstName"];
  vars.lastName = vars["contact.lastName"];
  vars.name = vars["contact.fullName"];
  vars.company = vars["contact.company"];
  vars.email = vars["contact.email"];
  vars.phone = vars["contact.phone"];
  return vars;
}

export async function renderCrmEmailTemplate(input: {
  template: CrmEmailTemplateLike;
  tenantId: string;
  userId: string;
  contactId?: string | null;
  toEmail?: string | null;
  sender?: { emailAddress?: string | null; senderName?: string | null; displayName?: string | null } | null;
  branding?: CrmEmailBrandingInput | null;
  signature?: CrmEmailSignatureInput | null;
}): Promise<RenderedCrmEmailTemplate> {
  const tenant = await (db as any).tenant.findUnique({ where: { id: input.tenantId }, select: { name: true } }).catch(() => null);
  const branding = input.branding || await resolveCrmEmailBranding(input.tenantId, tenant?.name, { logoMode: "cid" });
  const signature = input.signature || await resolveCrmEmailSignature({
    tenantId: input.tenantId,
    userId: input.userId,
    fallbackName: input.sender?.senderName || input.sender?.displayName,
    fallbackEmail: input.sender?.emailAddress,
    fallbackCompany: branding.businessName || tenant?.name,
  });
  const vars = await buildCrmEmailMergeVars({
    tenantId: input.tenantId,
    userId: input.userId,
    contactId: input.contactId,
    toEmail: input.toEmail,
    sender: input.sender,
    branding,
    signature,
  });
  const subject = renderCrmMergeTemplate(input.template.subject || "", vars);
  const previewText = renderCrmMergeTemplate(input.template.previewText || "", vars);
  const contentHtml = renderCrmMergeTemplate(resolveTemplateContentHtml(input.template), vars);
  const html = buildCrmEmailHtmlDocument({ subject, previewText, contentHtml, branding, signature });
  const text = renderCrmMergeTemplate(extractPlainTextFromTemplate(input.template), vars) || htmlToCrmPlainText(html);
  return { subject, previewText, html, text, vars };
}

export function getCrmEmailMergeFields() {
  return CRM_EMAIL_MERGE_FIELDS;
}
