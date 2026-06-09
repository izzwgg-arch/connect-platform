export type WebsiteSubmissionMode = "AUTO_CREATE" | "REVIEW_FIRST";

export type WebsiteSubmissionFieldKey =
  | "firstName"
  | "lastName"
  | "displayName"
  | "company"
  | "title"
  | "email"
  | "phone"
  | "address.street"
  | "address.city"
  | "address.state"
  | "address.zip"
  | "notes";

export type ExtractedWebsiteSubmissionFields = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  company?: string;
  title?: string;
  email?: string;
  phone?: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  notes?: string;
};

export type WebsiteSubmissionAnalysis = {
  detectedSenderEmail: string | null;
  detectedSenderDomain: string | null;
  detectedSubjectPattern: string | null;
  mappedFields: Record<WebsiteSubmissionFieldKey, string>;
  unmappedSummary: string[];
  attachmentExpectations: Array<{ fileName?: string; mimeType?: string; documentType: string }>;
  confidence: number;
};

export type RuleLike = {
  senderEmail?: string | null;
  senderDomain?: string | null;
  subjectPattern?: string | null;
  bodyPatterns?: unknown;
};

const FIELD_LABELS: Array<{ key: WebsiteSubmissionFieldKey; labels: string[] }> = [
  { key: "firstName", labels: ["first name", "firstname", "given name"] },
  { key: "lastName", labels: ["last name", "lastname", "surname", "family name"] },
  { key: "displayName", labels: ["name", "full name", "applicant name", "contact name"] },
  { key: "company", labels: ["company", "business", "business name", "employer"] },
  { key: "title", labels: ["title", "job title", "position"] },
  { key: "email", labels: ["email", "email address", "e-mail"] },
  { key: "phone", labels: ["phone", "phone number", "mobile", "cell", "telephone"] },
  { key: "address.street", labels: ["address", "street", "street address"] },
  { key: "address.city", labels: ["city"] },
  { key: "address.state", labels: ["state", "province"] },
  { key: "address.zip", labels: ["zip", "zip code", "postal code"] },
  { key: "notes", labels: ["message", "comments", "notes", "description"] },
];

const SENSITIVE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:ssn|social security)\s*[:#-]?\s*\d{3}[- ]?\d{2}[- ]?\d{4}\b/gi,
  /\b(?:account|acct|routing)\s*[:#-]?\s*\d{6,17}\b/gi,
  /\b\d{12,19}\b/g,
];

export function redactSensitiveText(input: string | null | undefined): string {
  let out = String(input || "");
  for (const pattern of SENSITIVE_PATTERNS) out = out.replace(pattern, (m) => {
    const last4 = (m.match(/\d/g) || []).join("").slice(-4);
    return last4 ? `[redacted:${last4}]` : "[redacted]";
  });
  return out;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

export function extractEmailDomain(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  const domain = normalized?.split("@")[1]?.toLowerCase();
  return domain || null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
}

export function parseEmailHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = String(raw || "").split(/\r?\n/);
  let currentKey: string | null = null;
  for (const line of lines) {
    if (!line.trim()) break;
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    headers[currentKey] = line.slice(idx + 1).trim();
  }
  return headers;
}

export function stripEmailHeaders(raw: string): string {
  const text = String(raw || "");
  const idx = text.search(/\r?\n\r?\n/);
  return idx >= 0 ? text.slice(idx).trim() : text.trim();
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function readLabeledValues(text: string): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 500) continue;
    const match = clean.match(/^([^:=]{2,80})\s*[:=]\s*(.+)$/);
    if (!match) continue;
    const label = normalizeLabel(match[1]);
    const value = redactSensitiveText(match[2].trim()).slice(0, 1000);
    if (value) rows.push({ label, value });
  }
  return rows;
}

function assignField(target: ExtractedWebsiteSubmissionFields, key: WebsiteSubmissionFieldKey, value: string) {
  const safe = value.trim();
  if (!safe) return;
  if (key === "address.street" || key === "address.city" || key === "address.state" || key === "address.zip") {
    target.address ||= {};
    const subKey = key.split(".")[1] as "street" | "city" | "state" | "zip";
    if (!target.address[subKey]) target.address[subKey] = safe;
    return;
  }
  if (key === "email") {
    const email = normalizeEmail(safe);
    if (email && !target.email) target.email = email;
    return;
  }
  if (key === "phone") {
    const phone = normalizePhone(safe);
    if (phone && !target.phone) target.phone = safe;
    return;
  }
  if (!target[key]) target[key] = safe;
}

export function extractWebsiteSubmissionFields(text: string, fieldMap?: Record<string, string>): {
  fields: ExtractedWebsiteSubmissionFields;
  mappedFields: Record<WebsiteSubmissionFieldKey, string>;
  unmappedSummary: string[];
  confidence: number;
} {
  const body = redactSensitiveText(text);
  const labeled = readLabeledValues(body);
  const fields: ExtractedWebsiteSubmissionFields = {};
  const mappedFields = {} as Record<WebsiteSubmissionFieldKey, string>;
  const mappedLabels = new Set<string>();
  const reverseMap = new Map<string, WebsiteSubmissionFieldKey>();
  for (const [label, key] of Object.entries(fieldMap || {})) {
    if (FIELD_LABELS.some((f) => f.key === key)) reverseMap.set(normalizeLabel(label), key as WebsiteSubmissionFieldKey);
  }

  for (const row of labeled) {
    const mapped = reverseMap.get(row.label) || FIELD_LABELS.find((candidate) =>
      candidate.labels.some((label) => row.label === label || row.label.includes(label)),
    )?.key;
    if (!mapped) continue;
    assignField(fields, mapped, row.value);
    mappedFields[mapped] ||= row.value;
    mappedLabels.add(row.label);
  }

  if (!fields.email) {
    const email = normalizeEmail(body);
    if (email) {
      fields.email = email;
      mappedFields.email ||= email;
    }
  }
  if (!fields.phone) {
    const phone = body.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
    if (phone) {
      fields.phone = phone;
      mappedFields.phone ||= phone;
    }
  }
  if (!fields.displayName && (fields.firstName || fields.lastName)) {
    fields.displayName = [fields.firstName, fields.lastName].filter(Boolean).join(" ");
  }

  const unmappedSummary = labeled
    .filter((row) => !mappedLabels.has(row.label))
    .slice(0, 12)
    .map((row) => `${row.label}: ${row.value.slice(0, 240)}`);
  const requiredSignals = [fields.email, fields.phone, fields.displayName || fields.firstName || fields.lastName].filter(Boolean).length;
  const mappedCount = Object.keys(mappedFields).length;
  const confidence = Math.min(0.98, Math.max(0.25, (requiredSignals * 0.22) + (mappedCount * 0.08)));
  return { fields, mappedFields, unmappedSummary, confidence };
}

export function analyzeWebsiteSubmissionSample(input: {
  rawEmail: string;
  fromEmail?: string | null;
  subject?: string | null;
  attachments?: Array<{ fileName?: string; mimeType?: string }>;
}): WebsiteSubmissionAnalysis {
  const headers = parseEmailHeaders(input.rawEmail);
  const from = normalizeEmail(input.fromEmail || headers.from || null);
  const subject = String(input.subject || headers.subject || "").trim() || null;
  const body = stripEmailHeaders(input.rawEmail);
  const extraction = extractWebsiteSubmissionFields(body);
  return {
    detectedSenderEmail: from,
    detectedSenderDomain: extractEmailDomain(from),
    detectedSubjectPattern: subject ? subject.replace(/\b\d+\b/g, "*").slice(0, 160) : null,
    mappedFields: extraction.mappedFields,
    unmappedSummary: extraction.unmappedSummary,
    attachmentExpectations: (input.attachments || []).slice(0, 10).map((a) => ({
      fileName: a.fileName,
      mimeType: a.mimeType,
      documentType: classifyAttachmentType(a.fileName || "", a.mimeType || ""),
    })),
    confidence: extraction.confidence,
  };
}

export function classifyAttachmentType(fileName: string, mimeType: string): string {
  const haystack = `${fileName} ${mimeType}`.toLowerCase();
  if (/(id|license|passport)/.test(haystack)) return "ID";
  if (/(bank|statement)/.test(haystack)) return "BANK_STATEMENT";
  if (/(pay|stub|payroll)/.test(haystack)) return "PAY_STUB";
  if (/(application|form)/.test(haystack)) return "APPLICATION";
  return "OTHER";
}

export function ruleMatchesEmail(rule: RuleLike, email: { fromEmail?: string | null; subject?: string | null; body?: string | null }): boolean {
  const from = normalizeEmail(email.fromEmail);
  const domain = extractEmailDomain(from);
  if (rule.senderEmail && from !== normalizeEmail(rule.senderEmail)) return false;
  if (rule.senderDomain && domain !== String(rule.senderDomain).toLowerCase()) return false;
  if (rule.subjectPattern) {
    const pattern = String(rule.subjectPattern).toLowerCase().replace(/\*/g, "");
    if (pattern && !String(email.subject || "").toLowerCase().includes(pattern)) return false;
  }
  const bodyPatterns = Array.isArray(rule.bodyPatterns) ? rule.bodyPatterns : [];
  for (const pattern of bodyPatterns) {
    const text = String(pattern || "").trim().toLowerCase();
    if (text && !String(email.body || "").toLowerCase().includes(text)) return false;
  }
  return true;
}

export function getWebsiteSubmissionFieldDefinitions() {
  return FIELD_LABELS.map((f) => ({ key: f.key, labels: f.labels }));
}
