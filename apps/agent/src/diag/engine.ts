/**
 * Diagnostics Engine v1 (PLAN.md §8) — deterministic, rule-based root-cause
 * ranking over the read tools. LLM (Claude) narrative enrichment layers on top
 * once API keys are present; the heuristics below are the certifiable core and
 * always run, so a missing/failed LLM never blocks a diagnosis.
 */
import type { ReadTools, ExtensionStatusResult, CdrSummary } from "../tools/readTools";
import type { AuditLog } from "../audit/audit";
import type { Notifier } from "../notify/notifier";
import type { ModelRouter } from "../llm/router";

export interface Hypothesis {
  cause: string;
  confidence: number; // 0..1
  fixPath: "agent_catalog" | "client_side" | "team" | "info";
  detail: string;
}

export interface DiagReport {
  id?: string;
  tenantId: string;
  extension: string | null;
  severity: "low" | "medium" | "high";
  findings: {
    devices: ExtensionStatusResult[];
    cdr: CdrSummary;
    complaint: string | null;
  };
  hypotheses: Hypothesis[];
  recommendation: string;
  narrative?: string; // LLM-written when available
}

export function rankHypotheses(devices: ExtensionStatusResult[], cdr: CdrSummary, complaint: string | null): Hypothesis[] {
  const h: Hypothesis[] = [];
  const anyRegistered = devices.some((d) => d.registered);
  const allUnseen = devices.length > 0 && devices.every((d) => d.status === "NO_DEVICE_SEEN");
  const unreachable = devices.filter((d) => d.status === "UNREACHABLE");
  const c = (complaint ?? "").toLowerCase();

  if (devices.length === 0) {
    h.push({ cause: "Extension not found for this tenant", confidence: 0.95, fixPath: "team", detail: "No such extension is provisioned — verify the extension number." });
    return h;
  }
  if (allUnseen) {
    h.push({ cause: "No device has ever registered on this extension", confidence: 0.85, fixPath: "team", detail: "The phone may never have been provisioned or has never reached the PBX." });
  }
  if (!anyRegistered && !allUnseen) {
    h.push({
      cause: "Device offline / not registered",
      confidence: 0.85,
      fixPath: "client_side",
      detail: `Device(s) currently ${unreachable.length ? "UNREACHABLE" : "UNREGISTERED"} — most often power, cabling, Wi-Fi, or client internet/router. Reboot the phone and check the network.`,
    });
  }
  if (anyRegistered && (c.includes("ring") || c.includes("קלינג"))) {
    h.push({
      cause: "Call routing diverts before the phone rings (forwarding, DND, time condition, or ring-group membership)",
      confidence: 0.6,
      fixPath: "agent_catalog",
      detail: "Device is registered and reachable, so signaling likely diverts: check DND, call-forwarding state, and time conditions for this extension.",
    });
  }
  if (cdr.shortAnsweredCalls >= 3) {
    h.push({
      cause: "One-way / dropped audio pattern (SIP ALG or NAT issue)",
      confidence: 0.7,
      fixPath: "client_side",
      detail: `${cdr.shortAnsweredCalls} answered calls under 15s in ${cdr.windowHours}h — classic router SIP ALG signature. Disable SIP ALG on the site router.`,
    });
  }
  if (cdr.totalCalls === 0 && anyRegistered) {
    h.push({
      cause: "No calls reaching this extension at all",
      confidence: 0.55,
      fixPath: "team",
      detail: `Zero CDRs in ${cdr.windowHours}h despite a registered device — inbound route/DID or upstream carrier issue is possible.`,
    });
  }
  if (h.length === 0) {
    h.push({
      cause: "No fault signature detected in registration or call records",
      confidence: 0.4,
      fixPath: "info",
      detail: "Device registered, call flow looks normal. Gather specifics (exact time of a failed call) and escalate with this report.",
    });
  }
  return h.sort((a, b) => b.confidence - a.confidence);
}

export class DiagnosticsEngine {
  constructor(
    private tools: ReadTools,
    private prisma: any,
    private audit: AuditLog,
    private notifier: Notifier,
    private llm: ModelRouter | null,
  ) {}

  async run(tenantId: string, extension: string | null, complaint: string | null, requestedBy: string): Promise<DiagReport> {
    const devices = extension ? await this.tools.extensionStatus(tenantId, extension) : await this.tools.extensionStatus(tenantId);
    const cdr = await this.tools.cdrHistory(tenantId, extension ?? undefined);
    const hypotheses = rankHypotheses(devices, cdr, complaint);
    const severity: DiagReport["severity"] =
      hypotheses[0]?.confidence >= 0.8 && hypotheses[0].fixPath !== "info" ? "high" : hypotheses[0]?.confidence >= 0.55 ? "medium" : "low";
    const recommendation = hypotheses[0]
      ? `${hypotheses[0].cause} — ${hypotheses[0].detail}`
      : "No recommendation.";

    const report: DiagReport = { tenantId, extension, severity, findings: { devices, cdr, complaint }, hypotheses, recommendation };

    // Optional LLM narrative (Claude) — never blocks.
    if (this.llm && this.llm.available().length > 0) {
      try {
        const res = await this.llm.complete("diagnostics", [
          { role: "system", content: "You are a telecom diagnostics analyst. Write a concise plain-language summary (5-8 sentences) of this phone-system diagnostic for a support team. No speculation beyond the data." },
          { role: "user", content: JSON.stringify({ complaint, devices, cdr, hypotheses }) },
        ], { maxTokens: 500 });
        report.narrative = res.text.trim();
      } catch {
        /* heuristics stand alone */
      }
    }

    const row = await this.prisma.agentDiagReport.create({
      data: {
        tenantId,
        extension,
        severity,
        findings: report.findings as any,
        hypotheses: report.hypotheses as any,
        recommendation: report.recommendation,
        sentTo: this.notifier.ownerRecipients(),
      },
    });
    report.id = row.id;

    await this.audit.record({ actor: "agent", event: "diag.completed", tenantId, capabilityId: "diag.full_diagnosis", payload: { reportId: row.id, severity, requestedBy, top: hypotheses[0]?.cause } });

    await this.notifier.send({
      kind: "escalation",
      to: this.notifier.ownerRecipients(),
      subject: `[Agent Diag ${severity.toUpperCase()}] ${tenantId}${extension ? ` ext ${extension}` : ""}: ${hypotheses[0]?.cause ?? "report"}`,
      text:
        `Diagnostic report ${row.id}\nTenant: ${tenantId}\nExtension: ${extension ?? "(all)"}\nComplaint: ${complaint ?? "-"}\nSeverity: ${severity}\n\n` +
        `Hypotheses:\n${hypotheses.map((x, i) => `${i + 1}. [${Math.round(x.confidence * 100)}%] ${x.cause} — ${x.detail}`).join("\n")}\n\n` +
        `Recommendation: ${report.recommendation}\n${report.narrative ? `\nAnalyst summary:\n${report.narrative}\n` : ""}`,
    });

    return report;
  }
}
