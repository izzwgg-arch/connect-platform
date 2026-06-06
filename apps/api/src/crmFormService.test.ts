import test from "node:test";
import assert from "node:assert/strict";
import {
  generateFormToken,
  hashFormToken,
  normalizeFieldInputs,
  publicFormDto,
  validateSubmission,
} from "./crm/formCore";
import { getCrmFormStorageRoot } from "./crm/formStorage";

test("CRM form tokens are random and stored as hashes", () => {
  const first = generateFormToken();
  const second = generateFormToken();
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashFormToken(first.token));
  assert.notEqual(first.tokenHash, first.token);
  assert.equal(first.tokenHash.length, 64);
});

test("CRM form field normalization preserves manual editor coordinates", () => {
  const fields = normalizeFieldInputs([
    { fieldType: "SIGNATURE", label: "Owner Signature", required: true, pageNumber: 1, x: 10, y: 20, width: 200, height: 40 },
  ]);
  assert.deepEqual(fields[0], {
    fieldType: "SIGNATURE",
    label: "Owner Signature",
    autoFillToken: null,
    required: true,
    pageNumber: 1,
    x: 10,
    y: 20,
    width: 200,
    height: 40,
    id: undefined,
    sortOrder: 0,
  });
});

test("CRM form submission validation blocks missing required fields", () => {
  const fields = [
    { id: "name", fieldType: "TEXT", required: true },
    { id: "agree", fieldType: "CHECKBOX", required: true },
    { id: "optional", fieldType: "TEXT", required: false },
  ];
  const result = validateSubmission(fields, { name: "Ada", agree: false, optional: "ok" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, { agree: "required" });
});

test("CRM public form DTO does not expose storage keys or token hashes", () => {
  const dto = publicFormDto({
    id: "req_1",
    status: "OPENED",
    expiresAt: new Date("2026-06-01T00:00:00Z"),
    completedAt: null,
    tokenHash: "secret",
    formTemplate: {
      id: "tpl_1",
      name: "Application",
      description: null,
      category: "Sales",
      pageCount: 2,
      storageKey: "tenants/t/template/original.pdf",
      fields: [],
    },
    contact: { displayName: "Lead", company: "Acme" },
    submission: null,
  });
  assert.equal(JSON.stringify(dto).includes("storageKey"), false);
  assert.equal(JSON.stringify(dto).includes("tokenHash"), false);
});

test("CRM public form DTO formats DATE token defaults for date inputs", () => {
  const dto = publicFormDto({
    id: "req_1",
    status: "OPENED",
    sentAt: new Date("2026-06-04T12:00:00Z"),
    expiresAt: new Date("2026-06-18T12:00:00Z"),
    completedAt: null,
    formTemplate: {
      id: "tpl_1",
      name: "Application",
      description: null,
      category: "Sales",
      pageCount: 1,
      fields: [
        {
          id: "field_1",
          fieldType: "DATE",
          label: "Effective date",
          autoFillToken: "form.date",
          required: true,
          pageNumber: 1,
          x: 1,
          y: 1,
          width: 10,
          height: 10,
        },
      ],
    },
    contact: { displayName: "Lead", company: "Acme" },
    submission: null,
  });
  assert.match(String(dto.fields[0]?.defaultValue), /^\d{4}-\d{2}-\d{2}$/);
});

test("CRM public form DTO hides fields after completion", () => {
  const dto = publicFormDto({
    id: "req_1",
    status: "COMPLETED",
    expiresAt: new Date("2026-06-01T00:00:00Z"),
    completedAt: new Date("2026-05-31T00:00:00Z"),
    formTemplate: {
      id: "tpl_1",
      name: "Application",
      description: null,
      category: "Sales",
      pageCount: 2,
      fields: [{ id: "field_1", fieldType: "SIGNATURE", label: "Signature", required: true, pageNumber: 1, x: 1, y: 1, width: 10, height: 10 }],
    },
    contact: { displayName: "Lead", company: "Acme" },
    submission: { submittedAt: new Date("2026-05-31T00:00:00Z") },
  });
  assert.deepEqual(dto.fields, []);
  assert.deepEqual(dto.submission, { submittedAt: "2026-05-31T00:00:00.000Z" });
});

test("CRM form storage fails closed in production without persistent root", () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldFormDir = process.env.CRM_FORM_STORAGE_DIR;
  const oldDocDir = process.env.CRM_DOC_STORAGE_DIR;
  process.env.NODE_ENV = "production";
  delete process.env.CRM_FORM_STORAGE_DIR;
  delete process.env.CRM_DOC_STORAGE_DIR;
  assert.throws(() => getCrmFormStorageRoot(), /crm_form_storage_dir_required/);
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
  if (oldFormDir === undefined) delete process.env.CRM_FORM_STORAGE_DIR;
  else process.env.CRM_FORM_STORAGE_DIR = oldFormDir;
  if (oldDocDir === undefined) delete process.env.CRM_DOC_STORAGE_DIR;
  else process.env.CRM_DOC_STORAGE_DIR = oldDocDir;
});
