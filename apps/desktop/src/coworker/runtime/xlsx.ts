/**
 * A real .xlsx writer and reader with no dependency: an .xlsx is a ZIP of XML
 * parts, and Node has zlib. Writes inline strings (no shared-string table
 * needed), reads both inline and shared strings. Enough for "make me a
 * spreadsheet" and "read this workbook" — not a formatting engine.
 */
import { promises as fsp } from "node:fs";
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

export type Cell = string | number | null | undefined | boolean;
export type Sheet = { name: string; rows: Cell[][] };

/* ─────────────────────────── zip (store/deflate) ─────────────────────────── */

type ZipEntry = { name: string; data: Buffer };

function dosDateTime(d = new Date()): { time: number; date: number } {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compressed = deflateRawSync(e.data);
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // Find the end-of-central-directory record (scan backwards, allow a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70_000); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("not_a_zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad_central_directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(localOff + 26); const lxlen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnlen + lxlen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported_zip_method_${method}`);
    if (data.length !== usize && usize !== 0xffffffff) throw new Error("zip_size_mismatch");
    out.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/* ─────────────────────────────── write ─────────────────────────────── */

// ⛔ The control-character class is written with \u escapes on purpose: real
// control bytes in a source file make git treat it as binary (no diff, ever).
const CONTROL_CHARS = new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f]", "g");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(CONTROL_CHARS, "");

export function colName(i: number): string {
  let s = ""; let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function sheetXml(rows: Cell[][]): string {
  const body: string[] = [];
  rows.forEach((row, r) => {
    const cells: string[] = [];
    (row ?? []).forEach((v, c) => {
      if (v === null || v === undefined || v === "") return;
      const ref = `${colName(c)}${r + 1}`;
      if (typeof v === "number" && Number.isFinite(v)) cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      else if (typeof v === "boolean") cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
      else cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`);
    });
    body.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join("")}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  if (!sheets.length) throw new Error("no_sheets");
  const safeName = (n: string, i: number) => (n || `Sheet${i + 1}`).replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
  const entries: ZipEntry[] = [];
  entries.push({ name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) });
  entries.push({ name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) });
  entries.push({ name: "xl/workbook.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) });
  entries.push({ name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`) });
  sheets.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows)) }));
  return buildZip(entries);
}

/* ─────────────────────────────── read ─────────────────────────────── */

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

function textOf(xml: string): string {
  return unesc(Array.from(xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((m) => m[1]).join(""));
}

export function colIndex(ref: string): number {
  const letters = ref.replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseXlsx(buf: Buffer, maxRows = 2000): { sheets: { name: string; rows: Cell[][] }[] } {
  const zip = readZip(buf);
  const wb = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const shared: string[] = [];
  const ss = zip.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1])?.[1]; const target = /Target="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) relTarget.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const sheets: { name: string; rows: Cell[][] }[] = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unesc(/name="([^"]*)"/.exec(m[1])?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(m[1])?.[1] ?? "";
    const target = relTarget.get(rid) ?? "";
    const xml = zip.get(target.startsWith("xl/") ? target : `xl/${target}`)?.toString("utf8") ?? "";
    const rows: Cell[][] = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) break;
      const row: Cell[] = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]; const inner = cm[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const idx = ref ? colIndex(ref) : row.length;
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        let value: Cell = null;
        if (type === "s") { const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]; value = v !== undefined ? shared[Number(v)] ?? "" : null; }
        else if (type === "inlineStr") value = textOf(inner);
        else if (type === "b") value = /<v>1<\/v>/.test(inner);
        else if (type === "str") value = unesc(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        else { const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]; value = v === undefined ? null : Number(v); if (typeof value === "number" && !Number.isFinite(value)) value = unesc(v ?? ""); }
        while (row.length < idx) row.push(null);
        row[idx] = value;
      }
      rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

export async function writeXlsxFile(abs: string, sheets: Sheet[]): Promise<number> {
  const buf = buildXlsx(sheets);
  await fsp.writeFile(abs, buf);
  return buf.length;
}

export async function readXlsxFile(abs: string, maxRows = 2000) {
  return parseXlsx(await fsp.readFile(abs), maxRows);
}
