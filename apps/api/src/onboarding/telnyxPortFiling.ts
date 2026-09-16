/**
 * Telnyx PORT FILING for onboarding (2026-09-16, Izzy: "switch the onboarding
 * wizard to Telnyx … and then same with porting").
 *
 * SignalWire has no porting API, so its sign-ups park a package in the admin
 * Port queue for a person. Telnyx has a full porting API (handoff §5), so a
 * Telnyx sign-up's port is FILED AND SUBMITTED here, from the same answers the
 * wizard collected — no person needed when the paperwork is complete:
 *
 *   draft order(s)  →  LOA (generated from the typed signature — the same PDF
 *   the Port queue serves) + the customer's bill uploaded as documents  →
 *   end user / service address / documents / activation configuration
 *   (connection + messaging profile applied AT port activation, so the number
 *   rings the PBX the moment it lands)  →  CONFIRM (submitted).
 *
 * State lives in answers.provisioning.portFiling (provider "telnyx"), which is
 * also what the admin Port queue lists — so a refused filing shows up there
 * with Telnyx's own words and the "Mark filed" workflow still works.
 *
 * ⛔ Idempotency, in the order it matters:
 *   • order ids are persisted the moment Telnyx returns them — a retry fills
 *     THOSE orders, never creates second ones on the customer's number;
 *   • document ids are persisted after each upload — never uploaded twice;
 *   • a submitted order is never confirmed again.
 * ⛔ Nothing here throws into the paid build for a Telnyx REFUSAL: refusals are
 * recorded as `needs_attention`. Only a programming error propagates (and the
 * caller catches that too).
 */
import * as fs from "node:fs";
import { db } from "@connect/db";
import { resolveTelnyxCredentials, type StoredTelnyxCredentials } from "../telnyx/telnyxCredentials";
import {
  confirmPortingOrder,
  createPortingOrders,
  getPortingOrder,
  updatePortingOrder,
  uploadDocument,
  telnyxErrorDetail,
  type TxPortingOrder,
} from "../telnyx/telnyxOnboardingClient";
import { buildLoaPdf, buildPortQueueRow } from "./portQueue";
import { resolveOnboardingStoragePath } from "./storage";
import { logOnboardingEvent as logEvent, mergeOnboardingProvisioningState as mergeProvisioningState } from "./voipMsProvisioning";

export type PortFilingDeps = {
  resolveCreds: typeof resolveTelnyxCredentials;
  createPortingOrders: typeof createPortingOrders;
  getPortingOrder: typeof getPortingOrder;
  updatePortingOrder: typeof updatePortingOrder;
  confirmPortingOrder: typeof confirmPortingOrder;
  uploadDocument: typeof uploadDocument;
  buildLoa: (row: any) => Promise<Buffer>;
  readUpload: (storageKey: string) => Buffer | null;
};

export function realPortFilingDeps(): PortFilingDeps {
  return {
    resolveCreds: resolveTelnyxCredentials,
    createPortingOrders,
    getPortingOrder,
    updatePortingOrder,
    confirmPortingOrder,
    uploadDocument,
    buildLoa: async (row) => {
      const q = buildPortQueueRow(row);
      if (!q) throw new Error("port_queue_row_unbuildable");
      return buildLoaPdf(q);
    },
    readUpload: (storageKey) => {
      try {
        const full = resolveOnboardingStoragePath(storageKey);
        return fs.existsSync(full) ? fs.readFileSync(full) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Statuses after which an order must never be confirmed again. */
const SUBMITTED_STATES = new Set(["in-process", "submitted", "exception", "foc-date-confirmed", "ported", "cancel-pending"]);

/** The PATCH body — pure, so the tests pin every field Telnyx is sent. */
export function buildTelnyxPortPatch(row: any, portedDid: string, ctx: { connectionId: string; messagingProfileId: string | null; customerReference: string }, docs: { loa: string | null; invoice: string | null }): Record<string, unknown> {
  const d: any = row?.answers?.phone?.details || {};
  const company = String(row?.companyName || row?.answers?.company?.name || "").trim();
  const signer = String(d.loaSignature || "").trim();
  const admin: Record<string, unknown> = {
    entity_name: String(d.nameOnAccount || company || signer).trim().slice(0, 100),
    auth_person_name: (signer || String(d.nameOnAccount || "")).slice(0, 100),
    billing_phone_number: `+1${portedDid}`,
    account_number: String(d.accountNumber || "").trim().slice(0, 50),
  };
  if (d.portPin) admin.pin_passcode = String(d.portPin).trim().slice(0, 20);
  const body: Record<string, unknown> = {
    customer_reference: ctx.customerReference,
    misc: { type: "full" },
    end_user: {
      admin,
      location: {
        street_address: String(d.serviceAddress || "").trim(),
        locality: String(d.serviceCity || "").trim(),
        administrative_area: String(d.serviceState || "").trim().toUpperCase(),
        postal_code: String(d.serviceZip || "").trim(),
        country_code: "US",
      },
    },
    phone_number_configuration: {
      connection_id: ctx.connectionId,
      ...(ctx.messagingProfileId ? { messaging_profile_id: ctx.messagingProfileId } : {}),
    },
  };
  const documents: Record<string, string> = {};
  if (docs.loa) documents.loa = docs.loa;
  if (docs.invoice) documents.invoice = docs.invoice;
  if (Object.keys(documents).length) body.documents = documents;
  return body;
}

type Filing = {
  provider: "telnyx";
  status: string;
  portedDid: string;
  requestedAt: string;
  orderIds?: string[];
  telnyxStatus?: Record<string, string>;
  loaDocumentId?: string | null;
  invoiceDocumentId?: string | null;
  submittedAt?: string | null;
  filedAt?: string | null;
  portReference?: string | null;
  error?: string | null;
  scopedLink?: boolean;
};

export async function fileTelnyxPortForSubmission(
  row: any,
  portedDid: string,
  ctx: { connectionId: string; messagingProfileId: string | null; customerReference: string },
  injected?: Partial<PortFilingDeps>,
): Promise<Filing> {
  const deps: PortFilingDeps = { ...realPortFilingDeps(), ...(injected || {}) };
  const submissionId = row.id;
  const prior: any = row?.answers?.provisioning?.portFiling || {};
  let filing: Filing = {
    provider: "telnyx",
    status: prior.provider === "telnyx" && prior.status ? String(prior.status) : "filing",
    portedDid,
    requestedAt: prior.requestedAt || new Date().toISOString(),
    orderIds: Array.isArray(prior.orderIds) ? prior.orderIds.map(String) : [],
    telnyxStatus: prior.telnyxStatus || {},
    loaDocumentId: prior.loaDocumentId || null,
    invoiceDocumentId: prior.invoiceDocumentId || null,
    submittedAt: prior.submittedAt || null,
    filedAt: prior.filedAt || null,
    portReference: prior.portReference || null,
    error: null,
    ...(prior.scopedLink ? { scopedLink: true } : {}),
  };
  const save = async (patch: Partial<Filing>) => {
    filing = { ...filing, ...patch };
    await mergeProvisioningState(row, { portFiling: filing });
  };
  if (filing.status === "submitted" || filing.status === "ported") {
    await logEvent(submissionId, `Port of ${portedDid} already submitted to Telnyx (${(filing.orderIds || []).join(", ")}) — not filing again.`);
    return filing;
  }
  // Stamp the package FIRST, so it is visible in the Port queue whatever happens next.
  await save({ status: "filing" });

  const creds = await deps.resolveCreds(db as never).catch(() => null);
  if (!creds) {
    await save({ status: "needs_attention", error: "telnyx_unconfigured" });
    return filing;
  }

  try {
    if (!filing.orderIds?.length) {
      const orders = await deps.createPortingOrders(creds, [`+1${portedDid}`], ctx.customerReference);
      if (!orders.length) throw new Error("telnyx_returned_no_porting_order");
      await save({ orderIds: orders.map((o) => o.id), telnyxStatus: Object.fromEntries(orders.map((o) => [o.id, String(o.status || "draft")])) });
      await logEvent(submissionId, `Port of ${portedDid}: Telnyx order ${orders.map((o) => o.id).join(", ")} opened.`);
    }

    if (!filing.loaDocumentId) {
      const loa = await deps.buildLoa(row);
      const id = await deps.uploadDocument(creds, `LOA-${portedDid}.pdf`, loa, ctx.customerReference);
      await save({ loaDocumentId: id });
    }
    if (!filing.invoiceDocumentId) {
      const bills = (Array.isArray(row?.uploadedFiles) ? row.uploadedFiles : []).filter((f: any) => f?.kind === "PORTING_BILL");
      for (const f of bills) {
        const bytes = deps.readUpload(String(f.storageKey || ""));
        if (!bytes) continue;
        const id = await deps.uploadDocument(creds, String(f.filename || `bill-${portedDid}.pdf`), bytes, ctx.customerReference);
        await save({ invoiceDocumentId: id });
        break;
      }
    }

    const statuses: Record<string, string> = { ...(filing.telnyxStatus || {}) };
    const refusals: string[] = [];
    for (const orderId of filing.orderIds || []) {
      const current: TxPortingOrder = await deps.getPortingOrder(creds, orderId);
      const now = String(current.status || "").toLowerCase();
      if (SUBMITTED_STATES.has(now)) {
        statuses[orderId] = now;
        continue;
      }
      try {
        await deps.updatePortingOrder(creds, orderId, buildTelnyxPortPatch(row, portedDid, ctx, { loa: filing.loaDocumentId || null, invoice: filing.invoiceDocumentId || null }));
        const confirmed = await deps.confirmPortingOrder(creds, orderId);
        statuses[orderId] = String(confirmed.status || "in-process").toLowerCase();
      } catch (e) {
        statuses[orderId] = now || "draft";
        refusals.push(`${orderId}: ${telnyxErrorDetail(e)}`);
      }
    }

    if (refusals.length) {
      const missingBill = !filing.invoiceDocumentId;
      await save({
        status: "needs_attention",
        telnyxStatus: statuses,
        error: `${refusals.join(" | ")}${missingBill ? " | no bill was uploaded" : ""}`.slice(0, 900),
      });
      await logEvent(submissionId, `⛔ Telnyx did not accept the port of ${portedDid} yet: ${refusals.join(" | ").slice(0, 300)}${missingBill ? " (no bill uploaded)" : ""}. It is in the Port queue for a person.`);
      return filing;
    }

    const at = new Date().toISOString();
    await save({ status: "submitted", telnyxStatus: statuses, submittedAt: at, filedAt: at, portReference: (filing.orderIds || []).join(", "), error: null });
    await logEvent(submissionId, `Port of ${portedDid} SUBMITTED to Telnyx (order ${(filing.orderIds || []).join(", ")}). The losing carrier sets the date; the number switches over by itself when it lands.`);
    return filing;
  } catch (e) {
    const detail = telnyxErrorDetail(e);
    await save({ status: "needs_attention", error: detail });
    await logEvent(submissionId, `⛔ Telnyx port filing for ${portedDid} stopped: ${detail}. It is in the Port queue for a person.`);
    return filing;
  }
}
