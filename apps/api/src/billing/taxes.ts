import { Prisma } from "@connect/db";

export type TaxProfileLike = {
  salesTaxRate?: Prisma.Decimal | number | string | null;
  e911FeePerExtension?: number | null;
  regulatoryFeePercent?: Prisma.Decimal | number | string | null;
  regulatoryFeeEnabled?: boolean | null;
};

export type TaxLine = {
  type: "SALES_TAX" | "E911_FEE" | "REGULATORY_FEE";
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
};

function decimalToNumber(value: TaxProfileLike["salesTaxRate"]): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return Number(value.toString()) || 0;
}

export function calculateTaxLines(input: {
  taxEnabled: boolean;
  taxProfile?: TaxProfileLike | null;
  taxableSubtotalCents: number;
  extensionCount: number;
}): TaxLine[] {
  if (!input.taxEnabled || !input.taxProfile) return [];

  const salesTaxRate = decimalToNumber(input.taxProfile.salesTaxRate);
  const regulatoryRate = decimalToNumber(input.taxProfile.regulatoryFeePercent);
  const e911Unit = Number(input.taxProfile.e911FeePerExtension || 0);
  const lines: TaxLine[] = [];

  const salesTax = Math.round(input.taxableSubtotalCents * salesTaxRate);
  if (salesTax > 0) {
    lines.push({
      type: "SALES_TAX",
      description: "Sales tax",
      quantity: 1,
      unitPriceCents: salesTax,
      amountCents: salesTax,
      taxable: false,
    });
  }

  const e911 = Math.max(0, input.extensionCount * e911Unit);
  if (e911 > 0) {
    lines.push({
      type: "E911_FEE",
      description: "E911 fee",
      quantity: input.extensionCount,
      unitPriceCents: e911Unit,
      amountCents: e911,
      taxable: false,
    });
  }

  const regulatory = input.taxProfile.regulatoryFeeEnabled === false ? 0 : Math.round(input.taxableSubtotalCents * regulatoryRate);
  if (regulatory > 0) {
    lines.push({
      type: "REGULATORY_FEE",
      description: "Regulatory recovery fee",
      quantity: 1,
      unitPriceCents: regulatory,
      amountCents: regulatory,
      taxable: false,
    });
  }

  return lines;
}
