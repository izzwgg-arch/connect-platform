/**
 * VitalPBX CSV generator for onboarding exports.
 *
 * Column order matches the official VitalPBX import spec exactly.
 * Each extension produces TWO rows:
 *   1. mode=add      — primary PJSIP device (Default PJSIP Profile, 5 max contacts, recording on)
 *   2. mode=add_device — WebRTC device     (Default WebRTC Profile, 3 max contacts, vitxi_client=yes)
 */

function csvEscapeCell(raw: string | number | null | undefined): string {
  const s = raw == null ? "" : String(raw);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** The 58 columns VitalPBX expects, in order. */
const HEADERS = [
  "mode",
  "extension",
  "ext_name",
  "language",
  "class_of_service",
  "technology",
  "profile_name",
  "device_user",
  "device_password",
  "device_description",
  "devices_emergency_cid_name",
  "devices_emergency_cid_number",
  "virtual_number",
  "ring_device",
  "codecs",
  "max_contacts",
  "features_password",
  "email",
  "did_number",
  "cid_number",
  "call-limit",
  "call_waiting",
  "vm_enabled",
  "vm_password",
  "saycid",
  "sayduration",
  "envelope",
  "attach",
  "delete",
  "ask_password",
  "skip_instructions",
  "outgoing_rec",
  "incoming_rec",
  "external_cid_name",
  "external_cid_number",
  "emergency_cid_name",
  "emergency_cid_number",
  "dial_profile",
  "accountcode",
  "followme_numbers",
  "initial_ringtime",
  "fw_ringtime",
  "ring_strategy",
  "followme-enabled",
  "recname",
  "enable_callee_prompt",
  "internal_numbers_confirmation",
  "dynamic_queues",
  "static_queues",
  "mobile_number",
  "home_number",
  "organization",
  "job_title",
  "send_welcome_email",
  "vitxi_client",
  "mobile_client",
  "notify_missed_calls",
  "callback_on_busy_transfer",
];

export type CsvExtensionRow = {
  extNumber: string;
  name?: string | null;
  email?: string | null;
  vmPassword?: string | null;
};

function makeRow(fields: Record<string, string | number>): string {
  return HEADERS.map((h) => csvEscapeCell(fields[h] ?? "")).join(",");
}

export function generateVitalPbxCsv(rows: CsvExtensionRow[]): { filename: string; mime: string; body: string } {
  // Validate
  const seen = new Set<string>();
  for (const r of rows) {
    const k = String(r.extNumber || "").trim();
    if (!k) throw new Error("missing_ext_number");
    if (seen.has(k)) throw new Error("duplicate_extension");
    seen.add(k);
  }

  const lines: string[] = [HEADERS.join(",")];

  for (const r of rows) {
    const ext = String(r.extNumber).trim();
    const name = (r.name || "").trim() || ext;
    const email = (r.email || "").trim();

    // ── Row 1: Primary PJSIP device ─────────────────────────────────────────
    lines.push(makeRow({
      mode:                       "add",
      extension:                  ext,
      ext_name:                   name,
      technology:                 "pjsip",
      profile_name:               "Default PJSIP Profile",
      device_user:                ext,
      device_description:         name,
      max_contacts:               5,
      email:                      email,
      vm_enabled:                 "yes",
      vm_password:                (r.vmPassword || "").trim() || undefined,
      outgoing_rec:               "yes",
      incoming_rec:               "yes",
    }));

    // ── Row 2: WebRTC device (add_device to the same extension) ─────────────
    lines.push(makeRow({
      mode:                       "add_device",
      extension:                  ext,
      technology:                 "pjsip",
      profile_name:               "Default WebRTC Profile",
      device_user:                `${ext}_1`,
      max_contacts:               3,
      vitxi_client:               "yes",
    }));
  }

  const body = lines.join("\r\n");
  const filename = `vitalpbx_extensions_${Date.now()}.csv`;
  return { filename, mime: "text/csv; charset=utf-8", body };
}
