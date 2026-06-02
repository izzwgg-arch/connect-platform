/** SMS length / encoding helpers shared by portal composers, API validation, and VoIP.ms sends. */

export const SMS_MAX_SEGMENTS = 10;
/** VoIP.ms REST `sendSMS` documented max chars per API call (no auto-concatenation). */
export const VOIPMS_SENDSMS_MAX_CHARS = 160;
/** Max Connect Chat SMS parts when auto-splitting for VoIP.ms. */
export const VOIPMS_SENDSMS_MAX_PARTS = 10;
export const VOIPMS_SMS_MAX_TOTAL_CHARS = VOIPMS_SENDSMS_MAX_CHARS * VOIPMS_SENDSMS_MAX_PARTS;
/** @deprecated Use VOIPMS_SENDSMS_MAX_CHARS — kept for docs referencing prior name. */
export const VOIPMS_SMS_MAX_LENGTH = VOIPMS_SENDSMS_MAX_CHARS;
export const GSM_SINGLE_SEGMENT = 160;
export const GSM_MULTI_SEGMENT = 153;
export const UCS2_SINGLE_SEGMENT = 70;
export const UCS2_MULTI_SEGMENT = 67;

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsTextAnalysis = {
  normalized: string;
  encoding: SmsEncoding;
  /** GSM septets or UCS-2 UTF-16 code units. */
  units: number;
  segments: number;
  singleSegmentLimit: number;
  multiSegmentUnitLimit: number;
  maxSegments: number;
  maxLength: number;
  overLimit: boolean;
  strippedInvisible: number;
  normalizedSmartPunct: number;
  payloadChars: number;
  payloadBytesUtf8: number;
  visibleChars: number;
  voipMsParts: number;
  voipMsPerPartLimit: number;
  exceedsVoipMsSinglePart: boolean;
};

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_BASIC_SET = new Set(GSM_BASIC.split(""));
const GSM_EXTENDED = new Set(["\\", "^", "{", "}", "[", "]", "~", "|", "€"]);
const INVISIBLE_CHARS = /[\uFEFF\u200B-\u200D\u2060\u180E\u00AD]/g;

/** Smart punctuation → GSM-safe ASCII (safe for SMS; preserves meaning). */
const SMART_PUNCT_TO_GSM: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2026": "...",
  "\u00A0": " ",
};

function gsmSeptetLength(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (GSM_EXTENDED.has(ch)) count += 2;
    else if (GSM_BASIC_SET.has(ch)) count += 1;
    else return -1;
  }
  return count;
}

function segmentCount(units: number, encoding: SmsEncoding): number {
  if (units <= 0) return 0;
  const single = encoding === "GSM-7" ? GSM_SINGLE_SEGMENT : UCS2_SINGLE_SEGMENT;
  const multi = encoding === "GSM-7" ? GSM_MULTI_SEGMENT : UCS2_MULTI_SEGMENT;
  if (units <= single) return 1;
  return Math.ceil(units / multi);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Safe normalization: line endings, invisible paste artifacts, smart punctuation. */
export function normalizeSmsComposeText(input: string): { text: string; strippedInvisible: number } {
  let strippedInvisible = 0;
  let text = String(input ?? "").replace(/\r\n?/g, "\n");
  text = text.replace(INVISIBLE_CHARS, () => {
    strippedInvisible += 1;
    return "";
  });
  return { text, strippedInvisible };
}

export function normalizeSmsForVoipMs(input: string): {
  text: string;
  strippedInvisible: number;
  normalizedSmartPunct: number;
} {
  const { text: base, strippedInvisible } = normalizeSmsComposeText(input);
  let normalizedSmartPunct = 0;
  let text = "";
  for (const ch of base) {
    const mapped = SMART_PUNCT_TO_GSM[ch];
    if (mapped !== undefined) {
      text += mapped;
      if (mapped !== ch) normalizedSmartPunct += 1;
    } else {
      text += ch;
    }
  }
  return { text, strippedInvisible, normalizedSmartPunct };
}

function voipMsPartLimitExceeded(part: string): boolean {
  if (part.length > VOIPMS_SENDSMS_MAX_CHARS) return true;
  const gsmUnits = gsmSeptetLength(part);
  if (gsmUnits >= 0) return gsmUnits > VOIPMS_SENDSMS_MAX_CHARS;
  return part.length > VOIPMS_SENDSMS_MAX_CHARS;
}

/** Split a body into VoIP.ms `sendSMS`-safe parts (≤160 chars and ≤160 GSM septets). */
export function splitVoipMsSendSmsParts(body: string): string[] {
  const { text } = normalizeSmsForVoipMs(body);
  if (!text) return [];

  const gsmUnits = gsmSeptetLength(text);
  if (gsmUnits >= 0) {
    const parts: string[] = [];
    let current = "";
    let units = 0;
    for (const ch of text) {
      const chUnits = GSM_EXTENDED.has(ch) ? 2 : 1;
      if (
        current &&
        (units + chUnits > VOIPMS_SENDSMS_MAX_CHARS || current.length + 1 > VOIPMS_SENDSMS_MAX_CHARS)
      ) {
        parts.push(current);
        current = ch;
        units = chUnits;
      } else {
        current += ch;
        units += chUnits;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    let chunkEnd = Math.min(i + VOIPMS_SENDSMS_MAX_CHARS, text.length);
    if (chunkEnd < text.length) {
      const code = text.charCodeAt(chunkEnd - 1);
      if (code >= 0xd800 && code <= 0xdbff) chunkEnd -= 1;
    }
    parts.push(text.slice(i, chunkEnd));
    i = chunkEnd;
  }
  return parts;
}

export function analyzeSmsText(rawInput: string): SmsTextAnalysis {
  const { text: normalized, strippedInvisible, normalizedSmartPunct } = normalizeSmsForVoipMs(rawInput);
  const gsmUnits = gsmSeptetLength(normalized);
  const encoding: SmsEncoding = gsmUnits >= 0 ? "GSM-7" : "UCS-2";
  const units = encoding === "GSM-7" ? gsmUnits : normalized.length;
  const segments = segmentCount(units, encoding);
  const voipMsParts = splitVoipMsSendSmsParts(normalized);
  const anyPartInvalid = voipMsParts.some(voipMsPartLimitExceeded);
  const overPartCount = voipMsParts.length > VOIPMS_SENDSMS_MAX_PARTS;
  const overTotalChars = normalized.length > VOIPMS_SMS_MAX_TOTAL_CHARS;
  const overLimit = overPartCount || overTotalChars || anyPartInvalid;

  return {
    normalized,
    encoding,
    units,
    segments,
    singleSegmentLimit: encoding === "GSM-7" ? GSM_SINGLE_SEGMENT : UCS2_SINGLE_SEGMENT,
    multiSegmentUnitLimit: encoding === "GSM-7" ? GSM_MULTI_SEGMENT : UCS2_MULTI_SEGMENT,
    maxSegments: SMS_MAX_SEGMENTS,
    maxLength: VOIPMS_SMS_MAX_TOTAL_CHARS,
    overLimit,
    strippedInvisible,
    normalizedSmartPunct,
    payloadChars: normalized.length,
    payloadBytesUtf8: utf8ByteLength(normalized),
    visibleChars: normalized.length,
    voipMsParts: voipMsParts.length,
    voipMsPerPartLimit: VOIPMS_SENDSMS_MAX_CHARS,
    exceedsVoipMsSinglePart: voipMsParts.length > 1,
  };
}

export type SmsTextValidation =
  | { ok: true; body: string; analysis: SmsTextAnalysis; voipMsParts: string[] }
  | { ok: false; code: "SMS_EMPTY" | "SMS_TOO_LONG"; message: string; analysis: SmsTextAnalysis; voipMsParts: string[] };

export function validateVoipMsSendSmsPart(body: string): SmsTextValidation {
  const trimmed = String(body ?? "").trim();
  const analysis = analyzeSmsText(trimmed);
  const voipMsParts = splitVoipMsSendSmsParts(trimmed);
  if (!analysis.normalized) {
    return { ok: false, code: "SMS_EMPTY", message: "SMS message cannot be empty.", analysis, voipMsParts };
  }
  if (analysis.overLimit) {
    return {
      ok: false,
      code: "SMS_TOO_LONG",
      message: formatVoipMsSmsTooLongMessage(analysis),
      analysis,
      voipMsParts,
    };
  }
  if (voipMsPartLimitExceeded(analysis.normalized)) {
    return {
      ok: false,
      code: "SMS_TOO_LONG",
      message: formatVoipMsSmsTooLongMessage(analysis),
      analysis,
      voipMsParts,
    };
  }
  return { ok: true, body: analysis.normalized, analysis, voipMsParts };
}

export function validateOutboundSmsText(raw: string): SmsTextValidation {
  const trimmed = String(raw ?? "").trim();
  const analysis = analyzeSmsText(trimmed);
  const voipMsParts = splitVoipMsSendSmsParts(trimmed);
  if (!analysis.normalized) {
    return { ok: false, code: "SMS_EMPTY", message: "SMS message cannot be empty.", analysis, voipMsParts };
  }
  if (analysis.overLimit) {
    return {
      ok: false,
      code: "SMS_TOO_LONG",
      message: formatVoipMsSmsTooLongMessage(analysis),
      analysis,
      voipMsParts,
    };
  }
  return { ok: true, body: analysis.normalized, analysis, voipMsParts };
}

export function formatVoipMsSmsTooLongMessage(analysis: SmsTextAnalysis): string {
  const parts: string[] = [];
  parts.push(
    `${analysis.payloadChars} chars (${analysis.payloadBytesUtf8} UTF-8 bytes) in ${analysis.encoding} encoding`,
  );
  if (analysis.encoding === "GSM-7" && analysis.units !== analysis.payloadChars) {
    parts.push(`${analysis.units} GSM septets (${analysis.payloadChars} visible chars)`);
  }
  if (analysis.voipMsParts > VOIPMS_SENDSMS_MAX_PARTS) {
    parts.push(`requires ${analysis.voipMsParts} VoIP.ms SMS parts (limit ${VOIPMS_SENDSMS_MAX_PARTS})`);
  } else if (analysis.exceedsVoipMsSinglePart) {
    parts.push(`requires ${analysis.voipMsParts} VoIP.ms SMS parts (${VOIPMS_SENDSMS_MAX_CHARS} chars/part)`);
  } else if (analysis.payloadChars > VOIPMS_SENDSMS_MAX_CHARS) {
    parts.push(`exceeds VoIP.ms sendSMS limit of ${VOIPMS_SENDSMS_MAX_CHARS} chars per message`);
  } else if (analysis.encoding === "GSM-7" && analysis.units > VOIPMS_SENDSMS_MAX_CHARS) {
    parts.push(`exceeds VoIP.ms GSM limit of ${VOIPMS_SENDSMS_MAX_CHARS} septets (${analysis.units} septets)`);
  }
  return `SMS too long for VoIP.ms: ${parts.join("; ")}.`;
}

export function formatVoipMsProviderRejection(
  providerStatus: string,
  body: string,
): string {
  const analysis = analyzeSmsText(body);
  if (String(providerStatus).toLowerCase() === "sms_toolong") {
    return formatVoipMsSmsTooLongMessage(analysis);
  }
  return `VoIP.ms sendSMS rejected: ${providerStatus} (${analysis.payloadChars} chars, ${analysis.encoding}, ${analysis.payloadBytesUtf8} bytes).`;
}

export function formatSmsCounterLabel(analysis: SmsTextAnalysis): {
  label: string;
  hint?: string;
  overLimit: boolean;
} {
  if (!analysis.normalized) return { label: "", overLimit: false };

  const encLabel = analysis.encoding === "GSM-7" ? "GSM-7" : "Unicode";
  const unitLabel =
    analysis.encoding === "GSM-7" && analysis.units !== analysis.payloadChars
      ? `${analysis.units} septets / ${analysis.payloadChars} chars`
      : `${analysis.payloadChars} chars`;

  const partSuffix =
    analysis.voipMsParts > 1
      ? ` · ${analysis.voipMsParts} VoIP.ms SMS`
      : "";

  const limitLabel = `${analysis.voipMsPerPartLimit}/${encLabel}`;

  if (analysis.overLimit) {
    return {
      label: `${unitLabel} · ${analysis.payloadBytesUtf8} bytes — too long for VoIP.ms (${limitLabel})${partSuffix}`,
      hint: buildCounterHint(analysis),
      overLimit: true,
    };
  }

  const singlePartHeadroom =
    analysis.encoding === "GSM-7"
      ? Math.min(VOIPMS_SENDSMS_MAX_CHARS - analysis.units, VOIPMS_SENDSMS_MAX_CHARS - analysis.payloadChars)
      : VOIPMS_SENDSMS_MAX_CHARS - analysis.payloadChars;

  return {
    label: `${unitLabel} · ${analysis.payloadBytesUtf8} bytes · ${limitLabel}${partSuffix}`,
    hint: buildCounterHint(analysis, singlePartHeadroom),
    overLimit: false,
  };
}

function buildCounterHint(analysis: SmsTextAnalysis, headroom?: number): string | undefined {
  const hints: string[] = [];
  if (analysis.strippedInvisible > 0) {
    hints.push(`${analysis.strippedInvisible} invisible character${analysis.strippedInvisible === 1 ? "" : "s"} removed`);
  }
  if (analysis.normalizedSmartPunct > 0) {
    hints.push(`${analysis.normalizedSmartPunct} smart punctuation character${analysis.normalizedSmartPunct === 1 ? "" : "s"} normalized for GSM`);
  }
  if (analysis.exceedsVoipMsSinglePart && !analysis.overLimit) {
    hints.push(`Will send as ${analysis.voipMsParts} separate SMS (${VOIPMS_SENDSMS_MAX_CHARS} chars each via VoIP.ms)`);
  } else if (analysis.encoding === "UCS-2" && headroom !== undefined) {
    hints.push(`Unicode SMS: ${headroom} chars remaining in this VoIP.ms message`);
  } else if (analysis.encoding === "GSM-7" && analysis.units !== analysis.payloadChars && headroom !== undefined) {
    hints.push(`Extended GSM symbols count double (${headroom} septets remaining)`);
  }
  return hints.length ? hints.join(" · ") : undefined;
}

/** @deprecated Use splitVoipMsSendSmsParts — kept for MMS link fallback call sites. */
export function splitSmsTextForMultipart(body: string): string[] {
  return splitVoipMsSendSmsParts(body);
}

export function voipMsSmsPayloadLogFields(body: string): Record<string, unknown> {
  const analysis = analyzeSmsText(body);
  return {
    encoding: analysis.encoding,
    payloadChars: analysis.payloadChars,
    payloadBytesUtf8: analysis.payloadBytesUtf8,
    gsmSeptets: analysis.encoding === "GSM-7" ? analysis.units : null,
    voipMsParts: analysis.voipMsParts,
    strippedInvisible: analysis.strippedInvisible,
    normalizedSmartPunct: analysis.normalizedSmartPunct,
    exceedsVoipMsSinglePart: analysis.exceedsVoipMsSinglePart,
  };
}
