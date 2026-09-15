import { test } from "node:test";
import assert from "node:assert/strict";
import bwipjs from "bwip-js";
import { readLabelBarcodes } from "./labelBarcodes";

/**
 * REAL engine, not a fake: these round-trips run zxing-cpp (WASM) against Code-128
 * PNGs generated in-process. The values are the first real label this feature was
 * built for (Izzy's T42S, 2026-09-15): an upside-down flash photo whose four OCR
 * passes read nothing while both barcodes carry everything.
 */
const png = (text: string, rotate: "N" | "R" | "I" | "L") =>
  bwipjs.toBuffer({ bcid: "code128", text, scale: 3, height: 12, rotate, backgroundcolor: "FFFFFF", paddingwidth: 12, paddingheight: 8 }) as Promise<Buffer>;

test("a MAC barcode decodes bare (parseDeviceLabel's MAC shape), at any rotation", async () => {
  for (const rotate of ["N", "I", "R", "L"] as const) {
    const out = await readLabelBarcodes(await png("805EC0B3B2D0", rotate));
    assert.deepEqual(out.texts, ["805EC0B3B2D0"], `rotation ${rotate}`);
  }
});

test("a serial barcode decodes prefixed SN (parseDeviceLabel only takes serials behind a prefix)", async () => {
  const out = await readLabelBarcodes(await png("2142019121401463", "I"));
  assert.deepEqual(out.texts, ["SN 2142019121401463"]);
  assert.equal(out.symbols, 1);
});

test("no symbol and junk input both answer empty — the OCR fallback must never be blocked", async () => {
  assert.deepEqual(await readLabelBarcodes(Buffer.from([])), { texts: [], symbols: 0 });
  assert.deepEqual(await readLabelBarcodes(Buffer.from("not an image at all")), { texts: [], symbols: 0 });
});

test("an implausible payload is dropped, a plausible non-MAC becomes an SN line", async () => {
  // 12 hex → bare MAC line; plausible alnum → SN line; the gate stays the judge either way.
  const mac = await readLabelBarcodes(await png("C074AD8C654E", "N"));
  assert.deepEqual(mac.texts, ["C074AD8C654E"]);
  const alnum = await readLabelBarcodes(await png("YD-T42S_0001463", "N"));
  assert.deepEqual(alnum.texts, ["SN YD-T42S_0001463"]);
});
