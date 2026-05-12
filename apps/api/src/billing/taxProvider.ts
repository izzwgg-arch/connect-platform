import type { TaxLine } from "./taxes";
import { calculateTaxLines, type TaxProfileLike } from "./taxes";

export const TAX_PROFILE_PROVIDER_ID = "tax_profile_v1";
export const TAX_PROFILE_PROVIDER_VERSION = "1.0.0";
export const EXTERNAL_TELECOM_STUB_PROVIDER_ID = "external_telecom_stub";

/** Persisted on `BillingInvoice.metadata.taxCalculationAudit` (JSON). Not legal advice. */
export type TaxCalculationAuditSnapshot = {
  providerId: string;
  providerVersion: string;
  computedAt: string;
  taxEnabled: boolean;
  taxProfileId: string | null;
  jurisdiction: { state?: string | null; county?: string | null; profileName?: string | null } | null;
  inputs: { taxableSubtotalCents: number; extensionCount: number };
  lines: Array<{ type: string; description: string; amountCents: number; quantity: number }>;
  notes?: string[];
};

export type TaxProviderInput = {
  tenantId: string;
  taxEnabled: boolean;
  taxProfile: (TaxProfileLike & { id?: string; name?: string; state?: string; county?: string | null }) | null;
  taxProfileId: string | null;
  taxableSubtotalCents: number;
  extensionCount: number;
};

export type TaxProviderResult = {
  lines: Array<TaxLine & { metadata?: Record<string, unknown> }>;
  audit: TaxCalculationAuditSnapshot;
};

export interface TaxProvider {
  readonly id: string;
  readonly version: string;
  calculateTaxes(input: TaxProviderInput): TaxProviderResult;
}

function auditBase(
  providerId: string,
  providerVersion: string,
  input: TaxProviderInput,
  lines: TaxProviderResult["lines"],
  notes?: string[],
): TaxCalculationAuditSnapshot {
  const tp = input.taxProfile;
  return {
    providerId,
    providerVersion,
    computedAt: new Date().toISOString(),
    taxEnabled: input.taxEnabled,
    taxProfileId: input.taxProfileId,
    jurisdiction:
      tp && (tp.state || tp.county != null || tp.name)
        ? { state: tp.state ?? null, county: tp.county ?? null, profileName: tp.name ?? null }
        : null,
    inputs: { taxableSubtotalCents: input.taxableSubtotalCents, extensionCount: input.extensionCount },
    lines: lines.map((l) => ({
      type: l.type,
      description: l.description,
      amountCents: l.amountCents,
      quantity: l.quantity,
    })),
    notes,
  };
}

/** Default: existing `TaxProfile` math via `taxes.ts` (sales tax, E911, regulatory). */
export class TaxProfileTaxProvider implements TaxProvider {
  readonly id = TAX_PROFILE_PROVIDER_ID;
  readonly version = TAX_PROFILE_PROVIDER_VERSION;

  calculateTaxes(input: TaxProviderInput): TaxProviderResult {
    if (!input.taxEnabled) {
      return {
        lines: [],
        audit: auditBase(this.id, this.version, input, [], ["tax_disabled"]),
      };
    }
    if (!input.taxProfile) {
      return {
        lines: [],
        audit: auditBase(this.id, this.version, input, [], [
          "tax_enabled_but_no_tax_profile",
          "Assign a TaxProfile or disable taxes until rates are verified.",
        ]),
      };
    }
    const raw = calculateTaxLines({
      taxEnabled: true,
      taxProfile: input.taxProfile,
      taxableSubtotalCents: input.taxableSubtotalCents,
      extensionCount: input.extensionCount,
    });
    const lines = raw.map((line) => ({
      ...line,
      metadata: { taxProviderId: this.id, taxLineType: line.type },
    }));
    return {
      lines,
      audit: auditBase(this.id, this.version, input, lines, ["tax_profile_math_v1"]),
    };
  }
}

/**
 * Placeholder for a future external telecom / VoIP tax engine.
 * Returns **no** tax lines — safe default until an adapter is implemented.
 */
export class ExternalTelecomTaxProviderStub implements TaxProvider {
  readonly id = EXTERNAL_TELECOM_STUB_PROVIDER_ID;
  readonly version = "0.0.0-stub";

  calculateTaxes(input: TaxProviderInput): TaxProviderResult {
    const lines: TaxProviderResult["lines"] = [];
    return {
      lines,
      audit: auditBase(this.id, this.version, input, lines, [
        "stub_provider_no_lines",
        "External telecom tax adapter not implemented — use tax_profile_v1 or disable taxes until a provider is integrated.",
        ...(input.taxEnabled && !input.taxProfile ? ["tax_enabled_without_tax_profile_context"] : []),
      ]),
    };
  }
}

export function readTaxProviderIdFromSettings(settings: { metadata?: unknown } | null | undefined): string {
  const m = settings?.metadata;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const id = String((m as Record<string, unknown>).taxProviderId || "").trim();
    if (id === EXTERNAL_TELECOM_STUB_PROVIDER_ID) return id;
    if (id === TAX_PROFILE_PROVIDER_ID) return id;
  }
  const env = String(process.env.BILLING_TAX_PROVIDER || "").trim();
  if (env === EXTERNAL_TELECOM_STUB_PROVIDER_ID) return env;
  return TAX_PROFILE_PROVIDER_ID;
}

export function resolveTaxProvider(settings: { metadata?: unknown } | null | undefined): TaxProvider {
  const id = readTaxProviderIdFromSettings(settings);
  if (id === EXTERNAL_TELECOM_STUB_PROVIDER_ID) return new ExternalTelecomTaxProviderStub();
  return new TaxProfileTaxProvider();
}
