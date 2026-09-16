/**
 * Barcode-first label reading. The MAC and serial on a Yealink/Grandstream sticker are
 * printed as Code-128 barcodes; decoding them (zxing-cpp via WASM, offline, no native
 * deps) is rotation-proof and checksummed, where OCR on a glossy label photo mangles
 * exactly the characters that matter (8/B, 0/D, 5/S). Proven need: Izzy's first real
 * label photo, 2026-09-15 — upside-down flash shot, four OCR passes, nothing read; both
 * barcodes in the same frame decode exactly.
 *
 * ⛔ This module only READS symbols and renders them as label TEXT for the ONE gate
 * (`recordLabel`) — it never judges acceptance itself. A 12-hex value is emitted bare
 * (parseDeviceLabel reads that as a MAC); anything else plausible is emitted as
 * "SN <value>" because parseDeviceLabel only takes a serial behind an SN/SERIAL prefix.
 * Edge accepted knowingly: a 12-DIGIT serial would read as a MAC candidate and, not
 * matching this phone, be refused by the gate — a refusal, never a wrong attach.
 */

export type LabelBarcodeRead = { texts: string[]; symbols: number };

/** 12 hex chars exactly — what parseDeviceLabel's bare-MAC form matches. */
const MAC_SHAPE = /^[0-9A-F]{12}$/i;
/** Serial-plausible: 5–40 chars, alphanumeric with - . _ (mirrors the route's serial rule). */
const SERIAL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{4,39}$/;

/**
 * Decode every barcode in the image and render one line of label text per symbol.
 * Returns { texts: [], symbols: 0 } for images with no readable symbol and on ANY
 * engine failure — the caller's OCR passes are the fallback, so a barcode problem
 * must never make a photo read WORSE than it did before this module existed.
 */
/**
 * Render decoded symbol VALUES as label text lines — one rule for every reader.
 * ⛔ Shared on purpose (2026-09-16): the customer scan page decodes in the browser for
 * speed, and its symbols must be shaped EXACTLY like the server photo path's, or the
 * one gate would be judging two different languages. Pure; never judges acceptance.
 */
export function labelTextsFromSymbols(decoded: readonly string[]): string[] {
  const texts: string[] = [];
  for (const raw of decoded) {
    const value = String(raw ?? "").trim();
    if (!value || value.length > 64) continue;
    if (MAC_SHAPE.test(value)) texts.push(value.toUpperCase());
    else if (SERIAL_SHAPE.test(value)) texts.push(`SN ${value}`);
  }
  return texts;
}

export async function readLabelBarcodes(image: Buffer): Promise<LabelBarcodeRead> {
  try {
    const { readBarcodes } = await import("zxing-wasm/reader");
    const results = await readBarcodes(new Uint8Array(image).slice().buffer as ArrayBuffer, {
      tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 8,
    });
    // ⛔ zxing answers junk input with a single empty error entry, not a throw — only an
    // entry that actually carries text counts as a symbol.
    const decoded = (results ?? []).map(r => String(r?.text ?? "").trim()).filter(v => v.length > 0);
    return { texts: labelTextsFromSymbols(decoded), symbols: decoded.length };
  } catch {
    return { texts: [], symbols: 0 };
  }
}
