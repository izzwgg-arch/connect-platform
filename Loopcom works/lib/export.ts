/**
 * Export utilities for CSV and data formatting
 */

export interface ExportOptions {
  filename?: string
  includeHeaders?: boolean
}

/**
 * Convert array of objects to CSV string
 */
export function arrayToCSV(data: any[], options: ExportOptions = {}): string {
  if (!data || data.length === 0) {
    return ''
  }

  const { includeHeaders = true } = options

  // Get all unique keys from all objects
  const allKeys = new Set<string>()
  data.forEach((item) => {
    Object.keys(item).forEach((key) => allKeys.add(key))
  })

  const keys = Array.from(allKeys)

  // Build CSV
  const rows: string[] = []

  // Headers
  if (includeHeaders) {
    rows.push(keys.map((key) => escapeCSVValue(key)).join(','))
  }

  // Data rows
  data.forEach((item) => {
    const values = keys.map((key) => {
      const value = item[key]
      if (value === null || value === undefined) {
        return ''
      }
      return escapeCSVValue(String(value))
    })
    rows.push(values.join(','))
  })

  return rows.join('\n')
}

/**
 * Escape CSV value (handle commas, quotes, newlines)
 */
function escapeCSVValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Download CSV file
 */
export function downloadCSV(csvContent: string, filename: string = 'export.csv'): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)

  link.setAttribute('href', url)
  link.setAttribute('download', filename)
  link.style.visibility = 'hidden'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Format date for export
 */
export function formatDateForExport(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toISOString().split('T')[0]
}

/**
 * Format datetime for export
 */
export function formatDateTimeForExport(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toISOString()
}

/**
 * Format currency for export
 */
export function formatCurrencyForExport(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return ''
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  return num.toFixed(2)
}
