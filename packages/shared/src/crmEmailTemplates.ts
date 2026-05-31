export type CrmEmailMergeGroup = "Contact" | "Company" | "CRM" | "Business" | "User/Sender";

export type CrmEmailMergeField = {
  token: string;
  label: string;
  group: CrmEmailMergeGroup;
  sample: string;
};

export type CrmEmailBrandingInput = {
  businessName?: string | null;
  tagline?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  logoUrl?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
};

export type CrmEmailSignatureInput = {
  senderName?: string | null;
  senderTitle?: string | null;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  avatarUrl?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
  legalDisclaimer?: string | null;
};

export const CRM_EMAIL_TEMPLATE_CATEGORIES = [
  "Sales",
  "Follow-up",
  "Appointment",
  "Welcome",
  "Renewal",
  "Collections",
  "Custom",
] as const;

export const CRM_EMAIL_MERGE_FIELDS: CrmEmailMergeField[] = [
  { group: "Contact", label: "First Name", token: "{{contact.firstName}}", sample: "Alex" },
  { group: "Contact", label: "Last Name", token: "{{contact.lastName}}", sample: "Morgan" },
  { group: "Contact", label: "Full Name", token: "{{contact.fullName}}", sample: "Alex Morgan" },
  { group: "Contact", label: "Email", token: "{{contact.email}}", sample: "alex@example.com" },
  { group: "Contact", label: "Phone", token: "{{contact.phone}}", sample: "(555) 123-4567" },
  { group: "Contact", label: "Mobile", token: "{{contact.mobile}}", sample: "(555) 987-6543" },
  { group: "Contact", label: "Company", token: "{{contact.company}}", sample: "Acme Dental" },
  { group: "Contact", label: "Address", token: "{{contact.address}}", sample: "123 Main Street" },
  { group: "Contact", label: "City", token: "{{contact.city}}", sample: "New York" },
  { group: "Contact", label: "State", token: "{{contact.state}}", sample: "NY" },
  { group: "Contact", label: "Zip Code", token: "{{contact.zipCode}}", sample: "10001" },
  { group: "Contact", label: "Timezone", token: "{{contact.timezone}}", sample: "Eastern" },
  { group: "Company", label: "Company", token: "{{company.name}}", sample: "Acme Dental" },
  { group: "CRM", label: "Assigned Agent", token: "{{crm.assignedAgent}}", sample: "Jordan Smith" },
  { group: "CRM", label: "Assigned Manager", token: "{{crm.assignedManager}}", sample: "Taylor Brooks" },
  { group: "CRM", label: "Campaign Name", token: "{{crm.campaignName}}", sample: "Spring Outreach" },
  { group: "CRM", label: "Lead Source", token: "{{crm.leadSource}}", sample: "Website" },
  { group: "CRM", label: "Lead Status", token: "{{crm.leadStatus}}", sample: "New Lead" },
  { group: "CRM", label: "Last Contact Date", token: "{{crm.lastContactDate}}", sample: "May 31, 2026" },
  { group: "Business", label: "Business Name", token: "{{business.name}}", sample: "Your Company" },
  { group: "Business", label: "Business Phone", token: "{{business.phone}}", sample: "(845) 723-1213" },
  { group: "Business", label: "Business Email", token: "{{business.email}}", sample: "hello@yourcompany.com" },
  { group: "Business", label: "Business Website", token: "{{business.website}}", sample: "www.yourcompany.com" },
  { group: "Business", label: "Business Address", token: "{{business.address}}", sample: "123 Main Street, New York, NY" },
  { group: "Business", label: "Business Logo", token: "{{business.logo}}", sample: "" },
  { group: "User/Sender", label: "Sender Name", token: "{{sender.name}}", sample: "John Smith" },
  { group: "User/Sender", label: "Sender Email", token: "{{sender.email}}", sample: "john.smith@yourcompany.com" },
  { group: "User/Sender", label: "Sender Phone", token: "{{sender.phone}}", sample: "(845) 723-1213" },
  { group: "User/Sender", label: "Sender Title", token: "{{sender.title}}", sample: "Sales Manager" },
  { group: "User/Sender", label: "Sender Signature", token: "{{sender.signature}}", sample: "" },
];

export const CRM_EMAIL_SAMPLE_MERGE_VALUES: Record<string, string> = Object.fromEntries(
  CRM_EMAIL_MERGE_FIELDS.map((field) => [
    field.token.replace(/^\{\{\s*|\s*\}\}$/g, ""),
    field.sample,
  ]),
);

export const CRM_EMAIL_LEGACY_ALIASES: Record<string, string> = {
  firstName: "contact.firstName",
  lastName: "contact.lastName",
  name: "contact.fullName",
  "contact.name": "contact.fullName",
  "contact.displayName": "contact.fullName",
  company: "contact.company",
  email: "contact.email",
  phone: "contact.phone",
  city: "contact.city",
  state: "contact.state",
};

export function escapeCrmEmailHtml(raw: unknown): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderCrmMergeTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const alias = CRM_EMAIL_LEGACY_ALIASES[key] || key;
    const val = vars[key] ?? vars[alias] ?? vars[key.replace(/\./g, "_")] ?? "";
    return String(val ?? "");
  });
}

export function htmlToCrmPlainText(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainTextToCrmHtml(text: string): string {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((part) => `<p>${escapeCrmEmailHtml(part).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export function buildCrmEmailSignatureHtml(signature: CrmEmailSignatureInput): string {
  const name = signature.senderName || "";
  const title = signature.senderTitle || "";
  const company = signature.companyName || "";
  const rows = [
    signature.phone,
    signature.email,
    signature.website,
  ].filter(Boolean);
  const social = [
    signature.facebookUrl,
    signature.instagramUrl,
    signature.linkedinUrl,
    signature.xUrl,
  ].filter(Boolean);
  if (!name && !title && !company && rows.length === 0 && social.length === 0) return "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #e5e7eb;padding-top:18px;">
      <tr>
        <td style="width:48px;vertical-align:top;">
          ${signature.avatarUrl || signature.logoUrl ? `<img src="${escapeCrmEmailHtml(signature.avatarUrl || signature.logoUrl)}" width="40" height="40" alt="" style="border-radius:999px;display:block;object-fit:cover;" />` : ""}
        </td>
        <td style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:13px;line-height:1.45;">
          ${name ? `<div style="font-weight:700;">${escapeCrmEmailHtml(name)}</div>` : ""}
          ${title || company ? `<div style="color:#4b5563;">${escapeCrmEmailHtml([title, company].filter(Boolean).join(", "))}</div>` : ""}
          ${rows.map((row) => `<div style="color:#2563eb;">${escapeCrmEmailHtml(row)}</div>`).join("")}
          ${social.length ? `<div style="margin-top:6px;color:#6b7280;">${social.map((url) => escapeCrmEmailHtml(url)).join(" · ")}</div>` : ""}
          ${signature.legalDisclaimer ? `<div style="margin-top:10px;color:#6b7280;font-size:11px;">${escapeCrmEmailHtml(signature.legalDisclaimer)}</div>` : ""}
        </td>
      </tr>
    </table>`;
}

export function buildCrmEmailHtmlDocument(input: {
  subject?: string | null;
  previewText?: string | null;
  contentHtml: string;
  branding?: CrmEmailBrandingInput | null;
  signature?: CrmEmailSignatureInput | null;
}): string {
  const branding = input.branding || {};
  const businessName = branding.businessName || "Your Company";
  const signatureHtml = input.signature ? buildCrmEmailSignatureHtml(input.signature) : "";
  const logo = branding.logoUrl
    ? `<img src="${escapeCrmEmailHtml(branding.logoUrl)}" width="36" height="36" alt="${escapeCrmEmailHtml(businessName)}" style="display:block;border-radius:10px;object-fit:contain;" />`
    : `<div style="width:36px;height:36px;border-radius:10px;background:#2563eb;color:white;text-align:center;line-height:36px;font-weight:700;">${escapeCrmEmailHtml(businessName.slice(0, 1).toUpperCase())}</div>`;
  const preview = input.previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeCrmEmailHtml(input.previewText)}</div>`
    : "";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeCrmEmailHtml(input.subject || "")}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f7fb;">
    ${preview}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px 14px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-right:12px;">${logo}</td>
                    <td style="font-family:Arial,Helvetica,sans-serif;">
                      <div style="font-size:16px;font-weight:700;color:#111827;">${escapeCrmEmailHtml(businessName)}</div>
                      ${branding.tagline ? `<div style="font-size:12px;color:#6b7280;">${escapeCrmEmailHtml(branding.tagline)}</div>` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 28px 28px 28px;font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.65;">
                ${input.contentHtml || ""}
                ${signatureHtml}
              </td>
            </tr>
            <tr>
              <td style="background:#f8fafc;padding:18px 28px;text-align:center;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:11px;line-height:1.5;">
                ${branding.address ? `<div>${escapeCrmEmailHtml(branding.address)}</div>` : ""}
                <div style="margin-top:6px;">
                  <a href="#" style="color:#2563eb;text-decoration:none;">Unsubscribe</a>
                  <span style="color:#cbd5e1;"> · </span>
                  <a href="#" style="color:#2563eb;text-decoration:none;">Privacy Policy</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
