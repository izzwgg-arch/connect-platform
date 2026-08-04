import { db } from "@connect/db";

/**
 * The owner's sign-up report: one plain-English email to the admin alert
 * address for every wizard sign-up that reaches the end of the pipeline —
 * whether it built cleanly or died on the way. Written for a reader who does
 * not want code, ids, or jargon: it says who signed up, what they chose, what
 * they paid, and whether anything needs a human.
 *
 * Rides the same ADMIN_ALERT EmailJob channel as the billing alerts (the API's
 * email-job processor picks these rows up and sends them).
 */

const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

function recipient(): string {
  return (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
}

function money(cents: number | null | undefined): string {
  const n = Math.round(Number(cents ?? 0));
  return `$${Math.floor(n / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")}`;
}

function prettyPhone(v: unknown): string {
  const d = String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (d.length !== 10) return String(v ?? "").trim();
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function nyTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(d);
}

/** Strip the technical crumbs (ids, paths, hashes) out of a timeline line. */
function humanizeEventLine(msg: string): string {
  return msg
    .replace(/\s*\((?:id|path)\s+[^)]+\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function queueOnboardingSignupReport(
  submissionId: string,
  outcome: "success" | "failed",
): Promise<boolean> {
  try {
    const sub = await (db as any).onboardingSubmission.findUnique({
      where: { id: submissionId },
      include: { requestedExtensions: true, events: { orderBy: { createdAt: "asc" } } },
    });
    if (!sub) return false;

    const answers: any = sub.answers || {};
    const phone: any = answers.phone || {};
    const porting: any = phone.details || {};
    const isPort = String(phone.choice || sub.phoneNumberChoice || "") === "port";
    const ownerExt = String(answers.ownerExtNumber || sub.requestedExtensions?.[0]?.extNumber || "");
    const company = String(sub.companyName || "this customer");

    const lines: string[] = [];

    lines.push(
      outcome === "success"
        ? `${company} just signed up through the wizard, and everything went through.`
        : `${company} signed up through the wizard, but the setup did NOT finish — it needs your attention.`,
    );
    lines.push("");

    lines.push("THE COMPANY");
    lines.push(`Company: ${company}`);
    const contact = [sub.contactFirstName, sub.contactLastName].filter(Boolean).join(" ");
    if (contact) lines.push(`Contact: ${contact}`);
    if (sub.mainEmail) lines.push(`Email: ${sub.mainEmail}`);
    if (sub.billingEmail && sub.billingEmail !== sub.mainEmail) lines.push(`Billing email: ${sub.billingEmail}`);
    if (sub.mainPhone) lines.push(`Phone: ${prettyPhone(sub.mainPhone)}`);
    const address = answers.contact?.address || answers.submit?.address;
    if (address) lines.push(`Address: ${address}`);
    if (String(answers.language || "") === "yi") lines.push("Screens language: Yiddish");
    lines.push("");

    lines.push("THEIR PHONE NUMBER");
    if (isPort) {
      lines.push(`They are bringing their own number over: ${prettyPhone(porting.numbers)} from ${porting.carrier || "their current carrier"}.`);
      if (sub.provisionedDid) {
        lines.push(`Until the transfer completes (usually 3-5 business days), they are live on a temporary number: ${prettyPhone(sub.provisionedDid)}.`);
      }
      lines.push(`Account number on file: ${porting.accountNumber ? "yes" : "NO — you may need to chase this"}. Transfer PIN: ${porting.portPin ? "yes" : "not given"}.`);
      lines.push(`Signed authorization: ${porting.loaFileName ? "uploaded" : "NOT uploaded — chase it"}. Copy of their bill: ${porting.billFileName ? "uploaded" : "NOT uploaded — chase it"}.`);
      const attachFailures: string[] = Array.isArray(answers?.provisioning?.portDocAttachFailures)
        ? answers.provisioning.portDocAttachFailures
        : [];
      if (attachFailures.length) {
        lines.push(`CHASE THIS: the customer uploaded ${attachFailures.join(", ")}, but sending ${attachFailures.length === 1 ? "it" : "them"} to the carrier FAILED. The transfer will stall until the paperwork is sent to VoIP.ms by hand.`);
      }
      lines.push("Remember: finishing the transfer (swapping the temporary number for their real one when the carrier releases it) is a manual step.");
    } else if (sub.provisionedDid) {
      lines.push(`They picked a new number and it is live: ${prettyPhone(sub.provisionedDid)}.`);
    } else if (phone.selectedNumber) {
      lines.push(`They picked a new number: ${prettyPhone(phone.selectedNumber)} (not activated yet).`);
    } else {
      lines.push("No number was chosen or activated.");
    }
    lines.push("");

    lines.push(`THE TEAM (${sub.requestedExtensions?.length ?? 0} ${(sub.requestedExtensions?.length ?? 0) === 1 ? "person" : "people"})`);
    for (const e of sub.requestedExtensions || []) {
      const bits = [`Extension ${e.extNumber}: ${e.displayName || "(no name)"}`];
      if (String(e.extNumber) === ownerExt) bits.push("OWNER — this is the account admin");
      bits.push(e.email ? `login goes to ${e.email}` : "no email, so no login for them");
      if (e.cellMode === "also") bits.push(`their cell (${prettyPhone(e.cellNumber)}) rings too`);
      if (e.cellMode === "only") bits.push(`calls go straight to their cell (${prettyPhone(e.cellNumber)})`);
      lines.push(bits.join(" — "));
    }
    lines.push("");

    lines.push("EXTRAS & MONEY");
    lines.push(`Text messaging: ${sub.smsEnabled ? "ON ($10 a month)" : "off"}.`);
    if (sub.paidAt) {
      lines.push(`First month: ${money(sub.paidAmountCents)} — paid ${nyTime(sub.paidAt)} on the checkout page. Their card is saved and monthly auto-pay is on.`);
    } else {
      lines.push("No payment has been collected.");
    }
    lines.push("");

    lines.push("HOW IT WENT");
    if (outcome === "success") {
      const dry = String(sub.pbxSetupStatus || "") === "dry_run_done";
      lines.push(
        dry
          ? "The system ran in practice mode (nothing was actually built) — check the automation switches."
          : "Number live, phone lines created, login emails sent, and the owner has full admin access (including setting up what callers hear). Nothing for you to do.",
      );
    } else {
      lines.push("The build stopped before finishing. In plain terms: the customer may have paid but does not have a working phone system yet.");
      if (sub.setupError) lines.push(`The system's reason, roughly: ${humanizeEventLine(String(sub.setupError))}`);
      lines.push("Open the admin onboarding page for this sign-up and use Retry — or reply to this email and your assistant will pick it up.");
    }
    lines.push("");

    lines.push("PLAY-BY-PLAY (their whole journey, oldest first)");
    const interesting = (sub.events || []).filter((e: any) => e.type !== "AUTOSAVED" && e.message);
    for (const e of interesting.slice(-40)) {
      lines.push(`${nyTime(e.createdAt)} — ${humanizeEventLine(String(e.message))}`);
    }

    const subject =
      outcome === "success"
        ? `New sign-up: ${company} — all set up`
        : `New sign-up: ${company} — NEEDS ATTENTION`;

    await (db as any).emailJob.create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        invoiceId: null,
        type: "ADMIN_ALERT",
        toEmail: recipient(),
        subject: `[Connect] ${subject}`,
        htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${lines.map(escapeHtml).join("<br/>")}</div>`,
        textBody: lines.join("\n"),
      },
    });
    return true;
  } catch {
    // A reporting failure must never break the pipeline it reports on.
    return false;
  }
}
