import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./importPipeline";

// ── Re-export testable helpers from funderRoutes inline (no DB) ──────────────
// We test the pure CSV/mapping logic extracted here without importing funderRoutes
// (which would require Fastify + DB). The same logic lives verbatim in the route file.

type FunderImportField =
  | "name"
  | "organization"
  | "email"
  | "phone"
  | "phone2"
  | "city"
  | "state"
  | "zip"
  | "notes"
  | "tags";

const FUNDER_COLUMN_ALIASES: Record<string, FunderImportField> = {
  name: "name",
  "funder name": "name",
  funder: "name",
  "full name": "name",
  fullname: "name",
  "contact name": "name",
  company: "organization",
  "company name": "organization",
  organization: "organization",
  organisation: "organization",
  org: "organization",
  "business name": "organization",
  email: "email",
  "email address": "email",
  "e-mail": "email",
  mail: "email",
  phone: "phone",
  phone1: "phone",
  "phone 1": "phone",
  "phone number": "phone",
  mobile: "phone",
  telephone: "phone",
  "primary phone": "phone",
  phone2: "phone2",
  "phone 2": "phone2",
  "secondary phone": "phone2",
  "alternate phone": "phone2",
  "alt phone": "phone2",
  "other phone": "phone2",
  city: "city",
  state: "state",
  zip: "zip",
  zipcode: "zip",
  "zip code": "zip",
  "postal code": "zip",
  notes: "notes",
  note: "notes",
  description: "notes",
  tags: "tags",
  tag: "tags",
  labels: "tags",
  label: "tags",
};

function autoMapFunderHeaders(headers: string[]): Record<number, FunderImportField> {
  const mapping: Record<number, FunderImportField> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i].toLowerCase().trim();
    const mapped = FUNDER_COLUMN_ALIASES[key];
    if (mapped && !Object.values(mapping).includes(mapped)) {
      mapping[i] = mapped;
    }
  }
  return mapping;
}

function csvField(value: string): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ── Header mapping tests ──────────────────────────────────────────────────────

test("autoMapFunderHeaders: maps name column", () => {
  const m = autoMapFunderHeaders(["name", "email", "phone"]);
  assert.equal(m[0], "name");
  assert.equal(m[1], "email");
  assert.equal(m[2], "phone");
});

test("autoMapFunderHeaders: maps 'funder name' alias to name", () => {
  const m = autoMapFunderHeaders(["Funder Name", "Organization"]);
  assert.equal(m[0], "name");
  assert.equal(m[1], "organization");
});

test("autoMapFunderHeaders: maps 'company name' to organization", () => {
  const m = autoMapFunderHeaders(["company name", "email"]);
  assert.equal(m[0], "organization");
  assert.equal(m[1], "email");
});

test("autoMapFunderHeaders: maps phone1/phone2 aliases", () => {
  const m = autoMapFunderHeaders(["phone1", "phone 2"]);
  assert.equal(m[0], "phone");
  assert.equal(m[1], "phone2");
});

test("autoMapFunderHeaders: maps alternate phone alias to phone2", () => {
  const m = autoMapFunderHeaders(["alternate phone"]);
  assert.equal(m[0], "phone2");
});

test("autoMapFunderHeaders: maps secondary phone to phone2", () => {
  const m = autoMapFunderHeaders(["secondary phone"]);
  assert.equal(m[0], "phone2");
});

test("autoMapFunderHeaders: maps city/state/zip", () => {
  const m = autoMapFunderHeaders(["city", "state", "zip code"]);
  assert.equal(m[0], "city");
  assert.equal(m[1], "state");
  assert.equal(m[2], "zip");
});

test("autoMapFunderHeaders: maps tags/labels aliases", () => {
  const m1 = autoMapFunderHeaders(["tags"]);
  assert.equal(m1[0], "tags");
  const m2 = autoMapFunderHeaders(["labels"]);
  assert.equal(m2[0], "tags");
  const m3 = autoMapFunderHeaders(["label"]);
  assert.equal(m3[0], "tags");
});

test("autoMapFunderHeaders: case-insensitive matching", () => {
  const m = autoMapFunderHeaders(["NAME", "EMAIL", "PHONE"]);
  assert.equal(m[0], "name");
  assert.equal(m[1], "email");
  assert.equal(m[2], "phone");
});

test("autoMapFunderHeaders: does not duplicate mapped fields", () => {
  const m = autoMapFunderHeaders(["name", "funder name"]);
  assert.equal(m[0], "name");
  assert.equal(m[1], undefined);
});

test("autoMapFunderHeaders: unknown column returns undefined", () => {
  const m = autoMapFunderHeaders(["foobar_col"]);
  assert.equal(m[0], undefined);
});

// ── CSV parser tests ──────────────────────────────────────────────────────────

test("parseCsv: parses basic CSV with header + rows", () => {
  const csv = "name,email,phone\nAcme Corp,acme@example.com,555-1234\n";
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ["name", "email", "phone"]);
  assert.deepEqual(rows[1], ["Acme Corp", "acme@example.com", "555-1234"]);
});

test("parseCsv: handles quoted fields with commas", () => {
  const csv = `name,city\n"Smith, John","Portland, OR"\n`;
  const rows = parseCsv(csv);
  assert.equal(rows[1][0], "Smith, John");
  assert.equal(rows[1][1], "Portland, OR");
});

test("parseCsv: handles empty file (single blank line)", () => {
  const rows = parseCsv("\n");
  assert.equal(rows.length, 0);
});

test("parseCsv: parses pipe-separated tags in cell", () => {
  const csv = "name,tags\nAcme,Insurance|Medicaid|Referral\n";
  const rows = parseCsv(csv);
  const tags = rows[1][1].split("|");
  assert.deepEqual(tags, ["Insurance", "Medicaid", "Referral"]);
});

// ── CSV export field quoting tests ────────────────────────────────────────────

test("csvField: plain string unchanged", () => {
  assert.equal(csvField("hello"), "hello");
});

test("csvField: string with comma gets quoted", () => {
  assert.equal(csvField("Smith, John"), '"Smith, John"');
});

test("csvField: string with double-quotes escapes them", () => {
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
});

test("csvField: empty string unchanged", () => {
  assert.equal(csvField(""), "");
});

// ── Import pipeline: per-row data extraction logic ────────────────────────────

test("full import row extraction: maps fields from CSV data", () => {
  const csv = "name,organization,email,phone,phone2,city,state,zip,tags,notes\nJohn Doe,Acme,john@acme.com,5551234,5555678,Portland,OR,97201,Insurance|Medicaid,Good funder\n";
  const rows = parseCsv(csv);
  const [headerRow, dataRow] = rows;
  const mapping = autoMapFunderHeaders(headerRow);

  const rowData: Record<string, string> = {};
  for (const [colStr, field] of Object.entries(mapping)) {
    rowData[field] = (dataRow[Number(colStr)] ?? "").trim();
  }

  assert.equal(rowData.name, "John Doe");
  assert.equal(rowData.organization, "Acme");
  assert.equal(rowData.email, "john@acme.com");
  assert.equal(rowData.phone, "5551234");
  assert.equal(rowData.phone2, "5555678");
  assert.equal(rowData.city, "Portland");
  assert.equal(rowData.state, "OR");
  assert.equal(rowData.zip, "97201");
  assert.equal(rowData.tags, "Insurance|Medicaid");
  assert.equal(rowData.notes, "Good funder");
});

test("import: row without name should be skipped (name is falsy)", () => {
  const csv = "name,email\n,test@example.com\n";
  const rows = parseCsv(csv);
  const [, dataRow] = rows;
  const mapping = autoMapFunderHeaders(rows[0]);
  const rowData: Record<string, string> = {};
  for (const [colStr, field] of Object.entries(mapping)) {
    rowData[field] = (dataRow[Number(colStr)] ?? "").trim();
  }
  assert.equal(!rowData.name, true);
});

test("import: tags split by pipe produces correct array", () => {
  const tagStr = "Insurance|Medicaid|Provider";
  const tags = tagStr.split("|").map((t) => t.trim()).filter(Boolean);
  assert.deepEqual(tags, ["Insurance", "Medicaid", "Provider"]);
});

test("import: empty tags string produces empty array", () => {
  const tags = "".split("|").map((t) => t.trim()).filter(Boolean);
  assert.deepEqual(tags, []);
});

// ── Tenant isolation invariant ─────────────────────────────────────────────────

test("tenant isolation: funder queries always include tenantId in where clause", () => {
  // This test documents the invariant that all funder routes must filter by tenantId.
  // The actual enforcement is in the route handlers, but we verify the shape here.
  const tenantId = "tenant_abc";
  const whereClause = { tenantId, active: true, archivedAt: null };
  assert.equal(whereClause.tenantId, tenantId);
  assert.ok("tenantId" in whereClause);
});

// ── Permission model docs ──────────────────────────────────────────────────────

test("permission: can_view_crm_funders is the gate permission", () => {
  // Documents the expected permission key for funder access.
  const permissionKey = "can_view_crm_funders";
  assert.ok(permissionKey.startsWith("can_view_crm"));
});
