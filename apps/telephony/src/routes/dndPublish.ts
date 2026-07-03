// Pure request-shape validation for POST /telephony/internal/dnd-publish.
// Extracted from telephony.ts so the validation contract (which AstDB
// families/keys can ever be produced, and which values are accepted) is unit
// testable without booting an express app or an AMI connection.
//
// This route writes ONLY two Connect-owned AstDB families, both consumed by
// [connect-wake-core]'s app-DND short-circuit (scripts/pbx/install-connect-wake-dialplan.sh):
//   connect/dnd/T<pbxTenantId>_<extension>     = "0" | "1"
//   connect/dnd_ts/T<pbxTenantId>_<extension>  = unix epoch seconds (digits only)
//
// There is deliberately NO generic "family"/"key" input — pbxTenantId and
// extension are validated independently as bare digit strings and the AstDB
// key is assembled server-side, so no caller input can ever select a
// different family or smuggle a path-like key (e.g. "../connect/system").

export type DndPublishParsed = {
  ok: true;
  pbxTenantId: string;
  extension: string;
  dnd: "0" | "1";
  ts: string;
  /** The AstDB key shared by both the connect/dnd and connect/dnd_ts families. */
  key: string;
};

export type DndPublishRejected = {
  ok: false;
  error:
    | "invalid_pbx_tenant_id"
    | "invalid_extension"
    | "invalid_dnd_value"
    | "invalid_timestamp";
};

const NUMERIC_ID_RE = /^\d{1,10}$/;
const TIMESTAMP_RE = /^\d{1,20}$/;

export function parseDndPublishRequest(body: unknown): DndPublishParsed | DndPublishRejected {
  const b = (body ?? {}) as Record<string, unknown>;
  const { pbxTenantId, extension, dnd, ts } = b;

  if (typeof pbxTenantId !== "string" || !NUMERIC_ID_RE.test(pbxTenantId)) {
    return { ok: false, error: "invalid_pbx_tenant_id" };
  }
  if (typeof extension !== "string" || !NUMERIC_ID_RE.test(extension)) {
    return { ok: false, error: "invalid_extension" };
  }
  if (dnd !== "0" && dnd !== "1") {
    return { ok: false, error: "invalid_dnd_value" };
  }
  if (typeof ts !== "string" || !TIMESTAMP_RE.test(ts)) {
    return { ok: false, error: "invalid_timestamp" };
  }

  return {
    ok: true,
    pbxTenantId,
    extension,
    dnd,
    ts,
    key: `T${pbxTenantId}_${extension}`,
  };
}
