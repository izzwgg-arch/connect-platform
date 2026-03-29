/**
 * Classify live call direction from Asterisk dialplan position (VitalPBX patterns).
 * Used by API live dashboard rows; mirrors telephony AMI logic where possible.
 */

export function inferPbxLiveDirection(
  context: string,
  exten: string,
  callerIdNum: string,
): "incoming" | "outgoing" | "internal" {
  const ctx = context.toLowerCase();
  const extenDigits = exten.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

  if (
    ctx.includes("from-trunk") ||
    ctx.includes("from-pstn") ||
    ctx.includes("from-external") ||
    ctx.includes("inbound")
  ) {
    return "incoming";
  }
  if (ctx.includes("default-trunk")) return "incoming";
  if (ctx.includes("incoming-calls")) return "incoming";
  if (ctx.includes("app-ivr")) return "incoming";
  if (/^ivr-\d/.test(ctx)) return "incoming";
  if (/^trk-[^-]+-in/.test(ctx)) return "incoming";

  if (
    ctx.includes("from-internal") ||
    ctx.includes("ext-local") ||
    ctx.includes("outbound")
  ) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    if (/^\d{10,}$/.test(extenDigits)) return "outgoing";
    return "incoming";
  }
  if (/^trk-[^-]+-dial/.test(ctx)) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    if (/^\d{10,}$/.test(extenDigits)) return "outgoing";
    return "incoming";
  }
  if (/^t\d+_cos-/.test(ctx)) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    if (/^\d{10,}$/.test(extenDigits)) return "outgoing";
    return "incoming";
  }
  if (ctx.includes("sub-local-dialing")) {
    if (/^\d{2,6}$/.test(exten)) return "internal";
    return "incoming";
  }

  if (/^\d{2,6}$/.test(callerIdNum) && /^\d{2,6}$/.test(exten)) return "internal";

  return "incoming";
}
