import { describe, expect, it } from 'vitest'
import { normalizeQboSalesItemLineAmounts, roundMoney } from '../lib/qbo/line-amounts'

describe('normalizeQboSalesItemLineAmounts', () => {
  it('keeps simple qty * unitPrice in sync', () => {
    const line = normalizeQboSalesItemLineAmounts({ quantity: 2, unitPrice: 10.5 })
    expect(line.amount).toBe(21)
    expect(roundMoney(line.qty * line.unitPrice)).toBe(line.amount)
  })

  it('honors stored total when qty * unitPrice would drift', () => {
    const line = normalizeQboSalesItemLineAmounts({
      quantity: 1.17,
      unitPrice: 1510.45,
      total: 1767.23,
    })
    expect(line.amount).toBe(1767.23)
    expect(roundMoney(line.qty * line.unitPrice)).toBe(1767.23)
  })

  it('fixes credit-memo style mismatch between total and unit fields', () => {
    const line = normalizeQboSalesItemLineAmounts({
      quantity: 3,
      unitPrice: 10.01,
      total: 30.03,
    })
    expect(line.amount).toBe(30.03)
    expect(roundMoney(line.qty * line.unitPrice)).toBe(30.03)
  })
})
