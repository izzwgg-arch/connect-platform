/**
 * "Suggest a feature" — the customer's way to ask for something new.
 *
 * It sits beside "Report a problem" in the assistant panel, but it is a
 * different animal on purpose: a fault report pages the owner's phone through
 * the escalation dispatcher, because a dead phone system cannot wait. A
 * feature suggestion is an EMAIL to the product inbox and nothing else —
 * nobody's phone rings at 2am for an idea.
 *
 * These builders are pure, same reason as supportReport.ts: the exact words
 * that land in the inbox are testable without a database or a mail server, and
 * the portal and the API share one min/max so they can never disagree about
 * what "long enough" means.
 */

export const FEATURE_SUGGESTION_MIN = 10;
export const FEATURE_SUGGESTION_MAX = 2000;

export type FeatureSuggestionInput = {
  tenantName: string;
  userName: string;
  userEmail?: string | null;
  /** What the customer typed, verbatim. Never summarised by a model. */
  suggestion: string;
  /** The page they were on when they suggested it — free context. */
  page?: string | null;
};

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The email the product inbox receives. Plain and internal — no branding shell,
 * no CTA: the reader is us, and the one action that matters (reply to the
 * customer) is spelled out with their address.
 */
export function buildFeatureSuggestionEmail(input: FeatureSuggestionInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Feature suggestion — ${input.suggestion.trim().slice(0, 60)}${input.suggestion.trim().length > 60 ? "…" : ""}`;

  const contact = input.userEmail ? `${input.userName} (${input.userEmail})` : input.userName;
  const textLines: string[] = [
    `A customer suggested a feature from the assistant panel.`,
    ``,
    `Company:  ${input.tenantName}`,
    `From:     ${contact}`,
  ];
  if (input.page) textLines.push(`Was on:   the ${input.page} page`);
  textLines.push(``, `What they said:`, input.suggestion.trim());
  if (input.userEmail) textLines.push(``, `Reply to ${input.userEmail} if you want to talk it through with them.`);
  const text = textLines.join("\n");

  const pageHtml = input.page
    ? `<p style="margin:0 0 4px;font-size:14px;color:#475569;">Was on: the ${escapeHtml(input.page)} page</p>`
    : "";
  const replyHtml = input.userEmail
    ? `<p style="margin:16px 0 0;font-size:14px;color:#475569;">Reply to ${escapeHtml(input.userEmail)} if you want to talk it through with them.</p>`
    : "";
  const html = `
    <p style="margin:0 0 12px;font-size:15px;color:#1e293b;">A customer suggested a feature from the assistant panel.</p>
    <p style="margin:0 0 4px;font-size:14px;color:#475569;">Company: <b>${escapeHtml(input.tenantName)}</b></p>
    <p style="margin:0 0 4px;font-size:14px;color:#475569;">From: ${escapeHtml(contact)}</p>
    ${pageHtml}
    <p style="margin:16px 0 6px;font-size:14px;color:#475569;">What they said:</p>
    <blockquote style="margin:0;padding:10px 14px;border-left:3px solid #cbd5e1;font-size:15px;color:#1e293b;white-space:pre-wrap;">${escapeHtml(input.suggestion.trim())}</blockquote>
    ${replyHtml}
  `;

  return { subject, text, html };
}
