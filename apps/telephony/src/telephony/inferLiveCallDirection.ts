import type { CallDirection } from "./types";

/**
 * Classify direction from Asterisk dialplan (VitalPBX). Shared by AMI ingest and ARI bridge polling.
 */
export function inferLiveCallDirection(
  context: string,
  exten: string,
  callerIdNum: string,
): CallDirection {
  const ctx = context.toLowerCase();

  if (
    ctx.includes("from-trunk") ||
    ctx.includes("from-pstn") ||
    ctx.includes("from-external") ||
    ctx.includes("inbound")
  ) {
    return "inbound";
  }
  if (ctx.includes("default-trunk")) return "inbound";
  if (ctx.includes("incoming-calls")) return "inbound";
  if (ctx.includes("app-ivr")) return "inbound";
  if (/^ivr-\d/.test(ctx)) return "inbound";
  if (/^trk-[^-]+-in/.test(ctx)) return "inbound";

  const extenDigits = exten.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

  if (
    ctx.includes("from-internal") ||
    ctx.includes("ext-local") ||
    ctx.includes("outbound")
  ) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    if (/^\d{10,}$/.test(extenDigits)) return "outbound";
    return "unknown";
  }
  if (/^trk-[^-]+-dial/.test(ctx)) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    if (/^\d{10,}$/.test(extenDigits)) return "outbound";
    return "unknown";
  }
  if (/^t\d+_cos-/.test(ctx)) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    if (/^\d{10,}$/.test(extenDigits)) return "outbound";
    return "unknown";
  }
  if (ctx.includes("sub-local-dialing")) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    return "unknown";
  }

  if (/^\d{2,6}$/.test(callerIdNum) && /^\d{2,6}$/.test(exten)) return "internal";

  return "unknown";
}
