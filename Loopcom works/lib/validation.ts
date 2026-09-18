import { z } from 'zod'
import { normalizeEmailList, splitEmailList } from '@/lib/email'
import { JOB_STATUS_VALUES } from '@/lib/jobs/statuses'
import { JOB_TYPE_VALUES } from '@/lib/jobs/types'

/**
 * Common validation schemas for API endpoints
 */

const nullableString = z.preprocess(
  (val) => (val === '' || val === undefined ? null : val),
  z.string().nullable().optional()
)

/** Strips newlines/tabs from a string field — prevents control chars from reaching QBO queries. */
const singleLineString = (schema: z.ZodString) =>
  z.preprocess((val) => (typeof val === 'string' ? val.replace(/[\r\n\t]+/g, ' ').trim() : val), schema)

// Branding settings payload (partial updates are allowed).
export const brandingSettingsSchema = z
  .object({
    primaryColor: nullableString,
    secondaryColor: nullableString,
    backgroundColor: nullableString,
    sidebarColor: nullableString,
    menuColor: nullableString,
    buttonColor: nullableString,
    buttonTextColor: nullableString,
    textPrimaryColor: nullableString,
    textSecondaryColor: nullableString,
    linkColor: nullableString,
    borderColor: nullableString,
    successColor: nullableString,
    warningColor: nullableString,
    dangerColor: nullableString,
    webLogoUrl: nullableString,
    faviconUrl: nullableString,
    mobileAppIconUrl: nullableString,
    mobileAppSplashLogoUrl: nullableString,
    invoicePdfTemplateId: nullableString,
    invoiceStyle: nullableString,
    invoiceBusinessName: nullableString,
    invoicePhone: nullableString,
    invoiceEmail: nullableString,
    invoiceAddress: nullableString,
    invoiceFooterText: nullableString,
    invoiceLogoUrl: nullableString,
    emailPrimaryColor: nullableString,
    emailButtonColor: nullableString,
    emailButtonTextColor: nullableString,
    emailBackgroundColor: nullableString,
    emailCardBackgroundColor: nullableString,
    emailHeaderBackgroundColor: nullableString,
    emailFooterBackgroundColor: nullableString,
    emailTextPrimaryColor: nullableString,
    emailTextSecondaryColor: nullableString,
    emailLinkColor: nullableString,
    emailBorderColor: nullableString,
    emailLogoUrl: nullableString,
    emailFooterText: nullableString,
    emailSignature: nullableString,
    emailCustomHeaderHTML: nullableString,
    emailCustomFooterHTML: nullableString,
  })
  .passthrough()

export const brandingResetSchema = z.object({
  section: z.enum(['ui', 'logos', 'invoice', 'email']),
})

// Pagination
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
})

// Date range
export const dateRangeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
})

// Job assignment
export const jobAssignmentSchema = z.object({
  jobId: z.string().min(1),
  techId: z.string().optional().nullable(),
  userId: z.string().optional().nullable(),
  userIds: z.array(z.string()).optional().nullable(),
  scheduledStart: z.string().optional().nullable(),
  scheduledEnd: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

// Job status update
export const jobStatusSchema = z.object({
  status: z.enum(JOB_STATUS_VALUES),
  notes: z.string().optional().nullable(),
})

// Report creation
export const reportSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional().nullable(),
  type: z.string().min(1),
  dataset: z.string().optional().nullable(),
  columns: z.any().optional().nullable(),
  filters: z.any().optional().nullable(),
  groupBy: z.any().optional().nullable(),
  aggregates: z.any().optional().nullable(),
  sorting: z.any().optional().nullable(),
})

// Mobile location update
export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().optional(),
  timestamp: z.string().datetime().optional(),
})

// Job note
export const jobNoteSchema = z.object({
  content: z.string().min(1).max(5000),
})

// Client creation
export const createClientSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().optional().nullable(),
  companyName: z.string().max(255).optional().nullable(),
  email: z
    .preprocess((val) => {
      if (val === '' || val === null || val === undefined) return null
      if (typeof val !== 'string') return val
      return normalizeEmailList(val)
    }, z.string().nullable().optional())
    .refine((val) => {
      if (!val) return true
      return splitEmailList(val).every((email) => z.string().email().safeParse(email).success)
    }, 'Invalid email address (use comma-separated emails like a@x.com, b@y.com)'),
  phone: z.string().max(50).optional().nullable(),
  website: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : val),
    z.string().url().nullable().optional()
  ),
  notes: z.string().max(5000).optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
  billingAddress: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string(),
    country: z.string().optional().default('US'),
  }).optional().nullable(),
  shippingAddress: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string(),
    country: z.string().optional().default('US'),
  }).optional().nullable(),
})

// Job creation
export const createJobSchema = z.object({
  clientId: z.string().min(1),
  title: singleLineString(z.string().min(1).max(255)),
  description: z.string().max(5000).optional().nullable(),
  status: z.enum(JOB_STATUS_VALUES).optional(),
  jobType: z.enum(JOB_TYPE_VALUES).optional(),
  priority: z.union([
    z.number().int().min(1).max(5),
    z.string().transform((val) => {
      // Try to parse as number
      const num = parseInt(val)
      if (!isNaN(num) && num >= 1 && num <= 5) return num
      return 3 // default
    })
  ]).optional(),
  scheduledStart: z.union([
    z.string().datetime(),
    z.string().transform((val) => {
      if (!val || val.trim() === '') return null
      const date = new Date(val)
      return isNaN(date.getTime()) ? null : date.toISOString()
    }),
    z.null()
  ]).optional().nullable(),
  scheduledEnd: z.union([
    z.string().datetime(),
    z.string().transform((val) => {
      if (!val || val.trim() === '') return null
      const date = new Date(val)
      return isNaN(date.getTime()) ? null : date.toISOString()
    }),
    z.null()
  ]).optional().nullable(),
  estimateAmount: z.string().or(z.number()).optional().nullable(),
  jobSite: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string(),
    country: z.string().optional().default('US'),
    notes: z.string().optional().nullable(),
  }).optional().nullable(),
})

// Invoice creation
const dateOrDateTime = z.string().refine((val) => {
  if (!val) return false
  // Accept both date-only (YYYY-MM-DD) and ISO datetime strings.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(val)
  if (dateOnly) return true
  return !Number.isNaN(Date.parse(val))
}, 'Invalid datetime')

export const createInvoiceSchema = z.object({
  invoiceNumber: z
    .preprocess((val) => {
      if (val === '' || val === null || val === undefined) return null
      return String(val)
    }, z.string().nullable().optional())
    .transform((val) => (val ? String(val).trim() : null)),
  clientId: z.string().min(1),
  jobId: z.string().optional().nullable(),
  estimateId: z.string().optional().nullable(),
  jobType: z.string().optional().nullable(),
  title: z.string().min(1).max(255),
  lineItems: z
    .array(
      z
        .object({
          description: z.string(),
          quantity: z
            .union([z.string(), z.number()])
            .transform((val) => (typeof val === 'string' ? parseFloat(val) : val)),
          unitPrice: z
            .union([z.string(), z.number()])
            .transform((val) => (typeof val === 'string' ? parseFloat(val) : val)),
          // Preserve existing per-field toggles and metadata (used by the UI).
          isVisibleToClient: z.boolean().optional(),
          showDescriptionToCustomer: z.boolean().optional(),
          showCostToCustomer: z.boolean().optional(),
          showPriceToCustomer: z.boolean().optional(),
          showTaxToCustomer: z.boolean().optional(),
          showNotesToCustomer: z.boolean().optional(),
          notes: z.string().optional().nullable(),
          vendorId: z.string().optional().nullable(),
          taxable: z.boolean().optional(),
          taxRate: z.union([z.string(), z.number()]).optional().nullable(),
          unitCost: z.union([z.string(), z.number()]).optional().nullable(),
          groupId: z.string().optional().nullable(),
          sourceItemId: z.string().optional().nullable(),
          sourceBundleId: z.string().optional().nullable(),
        })
        .passthrough()
    )
    .optional(),
  items: z.array(z.object({
    description: z.string(),
    quantity: z.number().positive(),
    // Allow negative unit price (credit / adjustment lines)
    unitPrice: z.number().finite(),
  })).min(1).optional(),
  optionalItems: z
    .array(
      z
        .object({
          description: z.string(),
          quantity: z
            .union([z.string(), z.number()])
            .transform((val) => (typeof val === 'string' ? parseFloat(val) : val)),
          unitPrice: z
            .union([z.string(), z.number()])
            .transform((val) => (typeof val === 'string' ? parseFloat(val) : val)),
          isVisibleToClient: z.boolean().optional(),
          showDescriptionToCustomer: z.boolean().optional(),
          showCostToCustomer: z.boolean().optional(),
          showPriceToCustomer: z.boolean().optional(),
          showTaxToCustomer: z.boolean().optional(),
          showNotesToCustomer: z.boolean().optional(),
          notes: z.string().optional().nullable(),
          vendorId: z.string().optional().nullable(),
          taxable: z.boolean().optional(),
          taxRate: z.union([z.string(), z.number()]).optional().nullable(),
          unitCost: z.union([z.string(), z.number()]).optional().nullable(),
          groupId: z.string().optional().nullable(),
          sourceItemId: z.string().optional().nullable(),
          sourceBundleId: z.string().optional().nullable(),
        })
        .passthrough()
    )
    .optional(),
  taxRate: z.union([z.string(), z.number()]).optional().nullable(),
  discount: z.union([z.string(), z.number()]).optional().nullable(),
  invoiceDate: dateOrDateTime.optional().nullable(),
  dueDate: dateOrDateTime.optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  isNotesVisibleToClient: z.boolean().optional(),
  terms: z.string().max(1000).optional().nullable(),
  memo: z.string().max(1000).optional().nullable(),
  progressBillingMode: z.enum(['FULL', 'PERCENTAGE', 'MANUAL']).optional().nullable(),
  progressBillingPercent: z.union([z.string(), z.number()]).optional().nullable(),
  // Line # / bundle groups (client temp ids remapped to DocumentLineGroup rows on create)
  groups: z
    .array(
      z.object({
        groupId: z.string().min(1),
        name: z.string(),
        sourceBundleId: z.string().optional().nullable(),
        customerDescription: z.string().optional().nullable(),
        customerTotal: z.union([z.string(), z.number()]).optional().nullable(),
        customerEdited: z.boolean().optional(),
      })
    )
    .optional(),
})

/**
 * Parse and validate request body
 */
export async function validateRequest<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<{ success: true; data: T } | { success: false; error: string; status: number }> {
  try {
    const body = await request.json()
    const data = schema.parse(body)
    return { success: true, data }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        status: 400,
      }
    }
    return {
      success: false,
      error: 'Invalid request body',
      status: 400,
    }
  }
}

/**
 * Parse and validate query parameters
 */
export function validateQuery<T>(
  searchParams: URLSearchParams,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: string; status: number } {
  try {
    const params = Object.fromEntries(searchParams.entries())
    const data = schema.parse(params)
    return { success: true, data }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        status: 400,
      }
    }
    return {
      success: false,
      error: 'Invalid query parameters',
      status: 400,
    }
  }
}
