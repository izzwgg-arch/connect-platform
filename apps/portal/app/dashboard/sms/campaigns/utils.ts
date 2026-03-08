"use client";

export type RecipientSummary = {
  totalInput: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  invalidRecipients: string[];
  normalizedRecipients: string[];
};

export function normalizeRecipientsFromText(raw: string): RecipientSummary {
  const tokens = raw
    .split(/[\s,;]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const invalidRecipients: string[] = [];
  const normalizedRecipients: string[] = [];
  let duplicateCount = 0;

  for (const token of tokens) {
    if (!/^\+[1-9]\d{7,14}$/.test(token)) {
      invalidRecipients.push(token);
      continue;
    }
    if (seen.has(token)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(token);
    normalizedRecipients.push(token);
  }

  return {
    totalInput: tokens.length,
    validCount: normalizedRecipients.length,
    invalidCount: invalidRecipients.length,
    duplicateCount,
    invalidRecipients: invalidRecipients.slice(0, 50),
    normalizedRecipients
  };
}

export function parseRecipientsFromCsvText(csv: string): string {
  const lines = csv.split(/\r?\n/g);
  const out: string[] = [];
  for (const line of lines) {
    const cols = line.split(",");
    for (const col of cols) {
      const v = col.trim().replace(/^"|"$/g, "");
      if (v) out.push(v);
    }
  }
  return out.join("\n");
}

export function mapCampaignBadgeStatus(status: string): "DRAFT" | "READY" | "SENDING" | "SENT" | "FAILED" | "BLOCKED" {
  if (status === "NEEDS_APPROVAL" || status === "PAUSED") return "BLOCKED";
  if (status === "QUEUED") return "READY";
  if (status === "SENDING") return "SENDING";
  if (status === "SENT") return "SENT";
  if (status === "FAILED") return "FAILED";
  return "DRAFT";
}
