/** SMS length / encoding helpers shared by portal composers and API validation. */

export const SMS_MAX_SEGMENTS = 10;
export const VOIPMS_SMS_MAX_LENGTH = 1600;
export const GSM_SINGLE_SEGMENT = 160;
export const GSM_MULTI_SEGMENT = 153;
export const UCS2_SINGLE_SEGMENT = 70;
export const UCS2_MULTI_SEGMENT = 67;

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsTextAnalysis = {
  normalized: string;
  encoding: SmsEncoding;
  /** GSM septets or UCS-2 code units (UTF-16), matching carrier billing units. */
  units: number;
  segments: number;
  singleSegmentLimit: number;
  multiSegmentUnitLimit: number;
  maxSegments: number;
  maxLength: number;
  overLimit: boolean;
  strippedInvisible: number;
};

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_BASIC_SET = new Set(GSM_BASIC.split(""));
const GSM_EXTENDED = new Set(["\\", "^", "{", "}", "[", "]", "~", "|", "€"]);
const INVISIBLE_CHARS = /[\uFEFF\u200B-\u200D\u2060\u180E\u00AD]/g;

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

/** Safe normalization: line endings + invisible paste artifacts only. */
export function normalizeSmsComposeText(input: string): { text: string; strippedInvisible: number } {
  let strippedInvisible = 0;
  let text = String(input ?? "").replace(/\r\n?/g, "\n");
  text = text.replace(INVISIBLE_CHARS, () => {
    strippedInvisible += 1;
    return "";
  });
  return { text, strippedInvisible };
}

export function analyzeSmsText(rawInput: string): SmsTextAnalysis {
  const { text: normalized, strippedInvisible } = normalizeSmsComposeText(rawInput);
  const gsmUnits = gsmSeptetLength(normalized);
  const encoding: SmsEncoding = gsmUnits >= 0 ? "GSM-7" : "UCS-2";
  const units = encoding === "GSM-7" ? gsmUnits : normalized.length;
  const segments = segmentCount(units, encoding);
  const overSegmentLimit = segments > SMS_MAX_SEGMENTS;
  const overLengthLimit = normalized.length > VOIPMS_SMS_MAX_LENGTH;

  return {
    normalized,
    encoding,
    units,
    segments,
    singleSegmentLimit: encoding === "GSM-7" ? GSM_SINGLE_SEGMENT : UCS2_SINGLE_SEGMENT,
    multiSegmentUnitLimit: encoding === "GSM-7" ? GSM_MULTI_SEGMENT : UCS2_MULTI_SEGMENT,
    maxSegments: SMS_MAX_SEGMENTS,
    maxLength: VOIPMS_SMS_MAX_LENGTH,
    overLimit: overSegmentLimit || overLengthLimit,
    strippedInvisible,
  };
}

export type SmsTextValidation =
  | { ok: true; body: string; analysis: SmsTextAnalysis }
  | { ok: false; code: "SMS_EMPTY" | "SMS_TOO_LONG"; message: string; analysis: SmsTextAnalysis };

export function validateOutboundSmsText(raw: string): SmsTextValidation {
  const trimmed = String(raw ?? "").trim();
  const analysis = analyzeSmsText(trimmed);
  if (!analysis.normalized) {
    return { ok: false, code: "SMS_EMPTY", message: "SMS message cannot be empty.", analysis };
  }
  if (analysis.overLimit) {
    const parts: string[] = [];
    if (analysis.normalized.length > VOIPMS_SMS_MAX_LENGTH) {
      parts.push(`${analysis.normalized.length} characters (limit ${VOIPMS_SMS_MAX_LENGTH})`);
    }
    if (analysis.segments > SMS_MAX_SEGMENTS) {
      const unitLabel = analysis.encoding === "GSM-7" ? "septets" : "characters";
      parts.push(
        `${analysis.segments} segments (limit ${SMS_MAX_SEGMENTS}; ${analysis.units} ${unitLabel} in ${analysis.encoding})`,
      );
    }
    return {
      ok: false,
      code: "SMS_TOO_LONG",
      message: `SMS too long: ${parts.join("; ")}.`,
      analysis,
    };
  }
  return { ok: true, body: analysis.normalized, analysis };
}

export function formatSmsCounterLabel(analysis: SmsTextAnalysis): {
  label: string;
  hint?: string;
  overLimit: boolean;
} {
  if (!analysis.normalized) return { label: "", overLimit: false };

  const capacity =
    analysis.segments <= 1
      ? analysis.singleSegmentLimit
      : analysis.segments * analysis.multiSegmentUnitLimit;

  if (analysis.overLimit) {
    return {
      label: `${analysis.units}/${analysis.maxLength} — too long (${analysis.segments} segment${analysis.segments === 1 ? "" : "s"}, ${analysis.encoding})`,
      hint:
        analysis.strippedInvisible > 0
          ? `${analysis.strippedInvisible} invisible character${analysis.strippedInvisible === 1 ? "" : "s"} removed from count`
          : undefined,
      overLimit: true,
    };
  }

  const segSuffix =
    analysis.segments > 1
      ? ` · ${analysis.segments} segments`
      : analysis.encoding === "UCS-2"
        ? ` · Unicode (${analysis.singleSegmentLimit}/segment)`
        : "";

  return {
    label: `${analysis.units}/${capacity}${segSuffix}`,
    hint:
      analysis.strippedInvisible > 0
        ? `${analysis.strippedInvisible} invisible character${analysis.strippedInvisible === 1 ? "" : "s"} removed from count`
        : analysis.encoding === "UCS-2" && analysis.segments === 1
          ? `Non-GSM characters use Unicode encoding (${analysis.singleSegmentLimit} chars per segment)`
          : undefined,
    overLimit: false,
  };
}

/** Split long SMS bodies for MMS→SMS link fallback segments. */
export function splitSmsTextForMultipart(body: string): string[] {
  const analysis = analyzeSmsText(body);
  const text = analysis.normalized;
  if (!text) return [];

  const chunkUnits = analysis.multiSegmentUnitLimit;
  const parts: string[] = [];

  if (analysis.encoding === "GSM-7") {
    let current = "";
    let units = 0;
    for (const ch of text) {
      const chUnits = GSM_EXTENDED.has(ch) ? 2 : 1;
      if (current && units + chUnits > chunkUnits) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = ch;
        units = chUnits;
      } else {
        current += ch;
        units += chUnits;
      }
    }
    const tail = current.trim();
    if (tail) parts.push(tail);
    return parts;
  }

  let i = 0;
  while (i < text.length) {
    let chunkEnd = i;
    let units = 0;
    while (chunkEnd < text.length) {
      const code = text.charCodeAt(chunkEnd);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff && chunkEnd + 1 < text.length;
      const step = isHighSurrogate ? 2 : 1;
      const chUnits = step;
      if (units + chUnits > chunkUnits) break;
      chunkEnd += step;
      units += chUnits;
    }
    if (chunkEnd === i) {
      chunkEnd = Math.min(i + 1, text.length);
    }
    const slice = text.slice(i, chunkEnd).trim();
    if (slice) parts.push(slice);
    i = chunkEnd;
  }
  return parts;
}
