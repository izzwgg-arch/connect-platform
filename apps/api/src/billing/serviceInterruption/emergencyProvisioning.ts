/**
 * VitalPBX native emergency calling, per tenant.
 *
 * ⛔⛔ WHY THIS EXISTS RATHER THAN A CUSTOM OUTBOUND ROUTE.
 * Proven from the live dialplan 2026-08-17 (`extensions__50-8-dialplan.conf`,
 * context `T8_cos-all-init`):
 *
 *     NoOp(Check if is an Emergency Call)
 *     GotoIf(DIALPLAN_EXISTS(T8_emergency-calls,${EXTENSION},1)=1 ? T8_emergency-calls)
 *     ...
 *     Set(OUTBOUND_PROFILE=${DB(.../outbound_profile)})
 *     GotoIf(OUTBOUND_PROFILE="disabled" ? post-dialing)
 *
 * The emergency check runs BEFORE the outbound profile is read. So a
 * configured emergency number bypasses route selection entirely — 911 still
 * goes out with every outbound route deactivated, and even when the
 * extension's outbound profile is "disabled". That is what lets the overdue
 * cutoff simply switch off the outbound routes with no carve-out to maintain.
 *
 * Panel contract captured 2026-08-17 by reading the two add forms. Both
 * modules are `multi_tenant`, so the tenant is selected with `setTenant()`
 * before posting — the row takes its tenant from the session cookie.
 */

import { assertSaved, type PanelSession } from "../../onboarding/panelClient";
import { EMERGENCY_ALLOWED_DESTINATIONS } from "./serviceInterruptionPolicy";

/** `states.country_id` for the United States. */
export const COUNTRY_US = "231";

export type Pairs = Array<[string, string]>;

export class EmergencyProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmergencyProvisionError";
  }
}

// ── Emergency location (the E911 address + the number dispatch sees) ─────────

export type EmergencyLocationInput = {
  csrf: string;
  /** Label in the panel, e.g. the company name. */
  name: string;
  streetNumber: string;
  streetName: string;
  city: string;
  /** `states.id` — 3956 is New York. */
  stateId: string;
  zipCode: string;
  cidName: string;
  /** ⛔ The customer's own number. Dispatch locates the caller from this. */
  cidNumber: string;
  countryId?: string;
  /** Optional suite/floor/unit. */
  addressType?: string;
  addressNumber?: string;
};

/** Split "15 Van Buren Dr" into its number and its street. */
export function splitStreet(address: string): { streetNumber: string; streetName: string } {
  const m = /^\s*([0-9]+[A-Za-z]?)\s+(.+?)\s*$/.exec(address || "");
  if (!m) return { streetNumber: "", streetName: (address || "").trim() };
  return { streetNumber: m[1], streetName: m[2] };
}

function digitsOnly(raw: string): string | null {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : null;
}

export function buildEmergencyLocationPairs(input: EmergencyLocationInput): Pairs {
  const cid = digitsOnly(input.cidNumber);
  if (!cid) {
    throw new EmergencyProvisionError(
      `Refusing to create an emergency location for "${input.name}" with caller ID ` +
        `"${input.cidNumber}" — dispatch locates the caller from that number.`,
    );
  }
  for (const [field, value] of [
    ["street name", input.streetName],
    ["city", input.city],
    ["state", input.stateId],
    ["zip code", input.zipCode],
  ] as const) {
    if (!String(value || "").trim()) {
      throw new EmergencyProvisionError(
        `Refusing to create an emergency location for "${input.name}" with no ${field}. ` +
          `An incomplete address sends help to the wrong place.`,
      );
    }
  }

  return [
    ["class", "emergency_locations"],
    ["method", "put"],
    ["mode", "add"],
    ["csfr_token", input.csrf],
    ["name", input.name],
    ["street_number", input.streetNumber],
    ["street_name", input.streetName],
    ["address_type", input.addressType ?? ""],
    ["address_number", input.addressNumber ?? ""],
    ["city", input.city],
    ["country_id", input.countryId ?? COUNTRY_US],
    ["state_id", input.stateId],
    ["state_id_custom", ""],
    ["zip_code", input.zipCode],
    ["cid_name", input.cidName],
    ["cid_number", cid],
  ];
}

// ── Emergency numbers (the category: numbers + trunks + notified emails) ─────

export type EmergencyNumbersInput = {
  csrf: string;
  /** Category description, e.g. "Matamim — emergency". */
  description: string;
  /** Trunk ids that carry emergency calls — the tenant's own. */
  trunkIds: string[];
  /** Notified when someone dials an emergency number. */
  emailAddresses: string[];
  /** Defaults to the platform allow-list. */
  numbers?: Array<{ number: string; description: string }>;
};

/** The numbers every customer gets: 911 and the local EMS/fire line. */
export function defaultEmergencyNumbers(): Array<{ number: string; description: string }> {
  const labels: Record<string, string> = {
    "911": "Emergency services",
    "8457831212": "Local EMS and fire department",
  };
  return EMERGENCY_ALLOWED_DESTINATIONS.map((n) => ({ number: n, description: labels[n] ?? "Emergency" }));
}

export function buildEmergencyNumbersPairs(input: EmergencyNumbersInput): Pairs {
  const numbers = input.numbers ?? defaultEmergencyNumbers();
  if (!numbers.length) throw new EmergencyProvisionError("Refusing to create an emergency category with no numbers.");
  if (!input.trunkIds.length) {
    throw new EmergencyProvisionError(
      `Refusing to create emergency numbers for "${input.description}" with no trunk — the call ` +
        `would have no way out of the building.`,
    );
  }

  const pairs: Pairs = [
    ["class", "emergency_numbers"],
    ["method", "put"],
    ["mode", "add"],
    ["csfr_token", input.csrf],
    ["description", input.description],
  ];
  numbers.forEach((n, i) => {
    pairs.push(
      [`numbers[${i}][number_id]`, ""],
      [`numbers[${i}][number]`, n.number],
      [`numbers[${i}][description]`, n.description],
    );
  });
  for (const t of input.trunkIds) pairs.push(["trunks[]", t]);
  // Both the owner and the customer are notified (Izzy, 2026-08-17).
  for (const e of input.emailAddresses) pairs.push(["email_addresses[]", e]);
  return pairs;
}

// ── Driver ──────────────────────────────────────────────────────────────────

export type TenantEmergencySetup = {
  /** `ombu_tenants.path` — selects which tenant the rows belong to. */
  tenantPath: string;
  companyName: string;
  address: { street: string; city: string; stateId: string; zip: string };
  cidNumber: string;
  trunkIds: string[];
  emailAddresses: string[];
};

/**
 * Create the location and the emergency-number category for one tenant.
 *
 * ⛔ Does NOT call Apply Changes. On this platform an apply wipes the Connect
 * doorway off every route of the tenant and flushes other tenants' pending
 * changes — callers get dead air until the reconciler heals it. The caller
 * decides when to apply and is responsible for re-baking the doorway after.
 */
export async function provisionTenantEmergency(
  s: PanelSession,
  setup: TenantEmergencySetup,
  log: (m: string) => void = () => {},
): Promise<{ locationPosted: boolean; numbersPosted: boolean }> {
  s.setTenant(setup.tenantPath);

  const { streetNumber, streetName } = splitStreet(setup.address.street);
  const locCsrf = await s.ensureCsrf("emergency_locations");
  if (!locCsrf) throw new EmergencyProvisionError("no csrf for emergency_locations");
  assertSaved(
    "emergency-location",
    await s.post(
      buildEmergencyLocationPairs({
        csrf: locCsrf,
        name: setup.companyName,
        streetNumber,
        streetName,
        city: setup.address.city,
        stateId: setup.address.stateId,
        zipCode: setup.address.zip,
        cidName: setup.companyName,
        cidNumber: setup.cidNumber,
      }),
    ),
  );
  log(`emergency location ok — ${setup.address.street}, ${setup.address.city} (cid ${setup.cidNumber})`);

  const numCsrf = await s.ensureCsrf("emergency_numbers");
  if (!numCsrf) throw new EmergencyProvisionError("no csrf for emergency_numbers");
  assertSaved(
    "emergency-numbers",
    await s.post(
      buildEmergencyNumbersPairs({
        csrf: numCsrf,
        description: `${setup.companyName} — emergency`,
        trunkIds: setup.trunkIds,
        emailAddresses: setup.emailAddresses,
      }),
    ),
  );
  log(`emergency numbers ok — ${defaultEmergencyNumbers().map((n) => n.number).join(", ")} via trunk ${setup.trunkIds.join(",")}`);

  return { locationPosted: true, numbersPosted: true };
}
