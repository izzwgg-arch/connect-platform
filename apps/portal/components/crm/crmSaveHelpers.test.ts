import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../services/apiClient";
import {
  formatCrmSaveError,
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
