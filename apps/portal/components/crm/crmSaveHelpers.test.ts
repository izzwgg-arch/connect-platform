import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../services/apiClient";
import {
  formatCrmSaveError,
  mergeChecklistSummaries,
  mergeScriptSummaries,
  requireSavedChecklist,
  requireSavedScript,
} from "./crmSaveHelpers";

test("requireSavedScript rejects missing script payload", () => {
  assert.throws(
    () => requireSavedScript({ script: undefined }),
    /Save did not return a script/,
  );
});

test("requireSavedScript accepts script with id", () => {
  const script = requireSavedScript({ script: { id: "script-1", name: "Test" } });
  assert.equal(script.id, "script-1");
});

test("requireSavedChecklist rejects empty id", () => {
  assert.throws(
    () => requireSavedChecklist({ checklist: { id: "  " } }),
    /Save did not return a checklist/,
  );
});

test("formatCrmSaveError includes ApiError detail", () => {
  const message = formatCrmSaveError(
    new ApiError("crm_permission_denied", 403, {
      error: "crm_permission_denied",
      detail: "CRM admin access required",
    }),
  );
  assert.match(message, /crm_permission_denied/);
  assert.match(message, /CRM admin access required/);
});

test("mergeChecklistSummaries keeps local rows missing from refetch", () => {
  const local = [
    {
      id: "new-checklist",
      name: "Fresh playbook",
      isActive: true,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
  ];
  const fetched = [
    {
      id: "old-checklist",
      name: "Existing playbook",
      isActive: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  const merged = mergeChecklistSummaries(local, fetched);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.id, "new-checklist");
});

test("mergeScriptSummaries keeps local rows missing from refetch", () => {
  const local = [
    {
      id: "new-script",
      name: "Fresh",
      isActive: true,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
  ];
  const fetched = [
    {
      id: "old-script",
      name: "Existing",
      isActive: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  const merged = mergeScriptSummaries(local, fetched);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.id, "new-script");
});
