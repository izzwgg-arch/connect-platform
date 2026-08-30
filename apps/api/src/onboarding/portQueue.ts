/**
 * The admin PORT QUEUE — SignalWire has NO porting API (mockup screen B's
 * honest constraint), so a port-in sign-up produces a complete ready-to-file
 * package (carrier account fields + the customer's TYPED LOA signature + the
 * uploaded bill) stamped `answers.provisioning.portFiling.status =
 * "awaiting_manual_filing"`. Filing is a 2-minute task in the SignalWire
 * dashboard; this module is the queue that surfaces those packages, the
 * generated LOA PDF, and the "mark filed" stamp.
 *
 * ⛔ Marking filed changes OUR record only — it never touches a carrier.
 * VoIP.ms-era ports (portFiled/portId, no portFiling block) are the old
 * automation's business and deliberately do NOT appear here.
 */
import PDFDocument from "pdfkit";

export type PortQueueRow = {
  submissionId: string;
  companyName: string;
  status: string;
  requestedAt: string | null;
  filedAt: string | null;
  portReference: string | null;
  portedDid: string;
  temporaryDid: string;
  carrier: string;
  accountNumber: string;
  nameOnAccount: string;
  isMobile: boolean;
  portPin: string;
  serviceAddress: string;
  loaSignature: string;
  files: Array<{ id: string; filename: string; kind: string | null }>;
  submittedAt: string | null;
};

function fmtDid(v: unknown): string {
  const d = String(v ?? "").replace(/\D/g, "").replace(/^1/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(v ?? "");
}

export function buildPortQueueRow(row: any): PortQueueRow | null {
  const a: any = row?.answers || {};
  const filing = a?.provisioning?.portFiling;
  if (!filing || typeof filing !== "object") return null;
  const details: any = a?.phone?.details || {};
  const addr = [details.serviceAddress, details.serviceCity, details.serviceState, details.serviceZip]
    .map((x: unknown) => String(x ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return {
    submissionId: String(row.id),
    companyName: String(row.companyName || a?.company?.companyName || ""),
    status: String(filing.status || "awaiting_manual_filing"),
    requestedAt: filing.requestedAt ? String(filing.requestedAt) : null,
    filedAt: filing.filedAt ? String(filing.filedAt) : null,
    portReference: filing.portReference ? String(filing.portReference) : null,
    portedDid: fmtDid(filing.portedDid || details.numbers),
    temporaryDid: fmtDid(a?.provisioning?.temporaryDid || row.provisionedDid),
    carrier: String(details.carrier || ""),
    accountNumber: String(details.accountNumber || ""),
    nameOnAccount: String(details.nameOnAccount || ""),
    isMobile: Boolean(details.isMobile),
    portPin: String(details.portPin || ""),
    serviceAddress: addr,
    loaSignature: String(details.loaSignature || ""),
    files: Array.isArray(row.uploadedFiles)
      ? row.uploadedFiles.map((f: any) => ({ id: String(f.id), filename: String(f.filename || "file"), kind: f.kind ? String(f.kind) : null }))
      : [],
    submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null,
  };
}

/**
 * The Letter of Authorization, generated from the wizard's answers + the typed
 * signature. This is what gets uploaded with the SignalWire dashboard filing —
 * SignalWire requires it signed and dated within 30 days, which is exactly why
 * the wizard collects the signature instead of mailing paperwork around.
 */
export function buildLoaPdf(row: PortQueueRow): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 64 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const line = (label: string, value: string) => {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text(label.toUpperCase(), { continued: false });
      doc.font("Helvetica").fontSize(12).fillColor("#0f172a").text(value || "—");
      doc.moveDown(0.6);
    };

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("Letter of Authorization — Number Transfer");
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(11).fillColor("#334155").text(
      "I authorize Loopcom LLC and its underlying carrier to act as my agent to transfer the telephone " +
      "number(s) below from my current service provider, and to take any actions necessary to complete the " +
      "transfer. Service with my current provider for these numbers may be disconnected upon completion.",
      { lineGap: 3 },
    );
    doc.moveDown(1);

    line("Telephone number(s) to transfer", row.portedDid);
    line("Current service provider", row.carrier);
    line("Account number", row.accountNumber);
    if (row.portPin) line(row.isMobile ? "Transfer PIN" : "PIN / passcode", row.portPin);
    line("Name on the account", row.nameOnAccount || row.loaSignature);
    line("Service address on file", row.serviceAddress);
    line("Company", row.companyName);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text("SIGNATURE");
    doc.moveDown(0.2);
    // The typed signature, rendered in an oblique face over a signing line —
    // the customer typed exactly this string into the wizard's signature box.
    doc.font("Helvetica-Oblique").fontSize(22).fillColor("#0f172a").text(row.loaSignature || "—");
    const y = doc.y + 4;
    doc.moveTo(64, y).lineTo(320, y).lineWidth(1).strokeColor("#94a3b8").stroke();
    doc.moveDown(0.6);
    line("Signed (typed) by", row.loaSignature);
    line("Date", new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" }));

    doc.moveDown(1);
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(
      "Signature captured electronically during sign-up. Generated by Loopcom for carrier filing.",
    );
    doc.end();
  });
}
