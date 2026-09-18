/* eslint-disable no-console */
/**
 * Factory reset (tenant-scoped) data wipe.
 *
 * Preserves:
 * - Users / auth tables
 * - Integration configuration (IntegrationConnection, QuickBooksIntegration, Webhook, Templates, Roles, etc.)
 * - Communication history (calls, sms, emails, conversations/messages)
 *
 * Deletes (for a tenant):
 * - Clients + subclients (and related contacts/addresses)
 * - Leads/Requests, Jobs
 * - Estimates/Invoices/Purchase Orders (+ line items via cascade)
 * - Payments & payment intents/events/transactions
 * - Vendors, Items, Item Categories, Price book, Bundles
 * - Tasks, Issues
 * - Operational logs (activities, audit logs, notifications, dispatch events, daily stats, webhook events, idempotency keys)
 *
 * Usage:
 *   node -r dotenv/config scripts/factory-reset-tenant.js --tenantId <id> --dry-run
 *   node -r dotenv/config scripts/factory-reset-tenant.js --tenantId <id> --confirm WIPE_TENANT_<id>
 */

require('dotenv').config()

const { PrismaClient } = require('@prisma/client')

function getArg(name) {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return null
  return process.argv[idx + 1] || null
}

function hasFlag(name) {
  return process.argv.includes(name)
}

async function main() {
  const tenantId = getArg('--tenantId')
  const confirm = getArg('--confirm')
  const dryRun = hasFlag('--dry-run')

  if (!tenantId) {
    console.error('Missing --tenantId')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, domain: true, subdomain: true },
    })
    if (!tenant) {
      console.error(`Tenant not found: ${tenantId}`)
      process.exit(1)
    }

    const expectedConfirm = `WIPE_TENANT_${tenantId}`

    console.log('Factory reset (tenant-scoped)')
    console.log(`Tenant: ${tenant.name} (${tenant.id})${tenant.domain ? ` domain=${tenant.domain}` : ''}${tenant.subdomain ? ` subdomain=${tenant.subdomain}` : ''}`)
    console.log(`Mode: ${dryRun ? 'DRY RUN (no deletes)' : 'DELETE'}`)
    console.log('Preserving: users + integrations config + comm history')
    console.log('Wiping: business data (clients/jobs/docs/vendors/items/tasks/issues/payments/etc)')
    console.log('')
    if (!dryRun) {
      if (!confirm) {
        console.error(`Missing --confirm. To proceed, pass: --confirm ${expectedConfirm}`)
        process.exit(1)
      }
      if (confirm !== expectedConfirm) {
        console.error(`Invalid --confirm. Expected: ${expectedConfirm}`)
        process.exit(1)
      }
    }

    const counts = async () => {
      const [
        clients,
        leads,
        jobs,
        estimates,
        invoices,
        purchaseOrders,
        vendors,
        items,
        tasks,
        issues,
        payments,
        paymentIntents,
        paymentEvents,
        paymentTransactions,
        activities,
        auditLogs,
        notifications,
        schedules,
        dispatchEvents,
        dailyStats,
        webhookEvents,
        idempotencyKeys,
        addressesByClient,
        addressesByJob,
      ] = await Promise.all([
        prisma.client.count({ where: { tenantId } }),
        prisma.lead.count({ where: { tenantId } }),
        prisma.job.count({ where: { tenantId } }),
        prisma.estimate.count({ where: { tenantId } }),
        prisma.invoice.count({ where: { tenantId } }),
        prisma.purchaseOrder.count({ where: { tenantId } }),
        prisma.vendor.count({ where: { tenantId } }),
        prisma.item.count({ where: { tenantId } }),
        prisma.task.count({ where: { tenantId } }),
        prisma.issue.count({ where: { tenantId } }),
        // Payment has no tenantId; scope via invoice.tenantId
        prisma.payment.count({ where: { invoice: { tenantId } } }),
        prisma.invoicePaymentIntent.count({ where: { tenantId } }),
        prisma.paymentEvent.count({ where: { tenantId } }),
        prisma.paymentTransaction.count({ where: { tenantId } }),
        prisma.activity.count({ where: { tenantId } }),
        prisma.auditLog.count({ where: { tenantId } }),
        prisma.notification.count({ where: { tenantId } }),
        prisma.schedule.count({ where: { tenantId } }),
        prisma.dispatchEvent.count({ where: { tenantId } }),
        prisma.dailyStats.count({ where: { tenantId } }),
        prisma.webhookEvent.count({ where: { tenantId } }),
        prisma.idempotencyKey.count({ where: { tenantId } }),
        prisma.address.count({ where: { client: { tenantId } } }),
        prisma.address.count({ where: { job: { tenantId } } }),
      ])

      return {
        clients,
        leads,
        jobs,
        estimates,
        invoices,
        purchaseOrders,
        vendors,
        items,
        tasks,
        issues,
        payments,
        paymentIntents,
        paymentEvents,
        paymentTransactions,
        activities,
        auditLogs,
        notifications,
        schedules,
        dispatchEvents,
        dailyStats,
        webhookEvents,
        idempotencyKeys,
        addressesByClient,
        addressesByJob,
      }
    }

    const before = await counts()
    console.table(before)

    if (dryRun) {
      console.log('Dry run complete. No deletes performed.')
      return
    }

    console.log('Deleting...')

    // Order matters due to onDelete: Restrict constraints (e.g., invoices <-> payments, clients <-> invoices).
    await prisma.$transaction(async (tx) => {
      // Payments first (Invoice has Restrict).
      await tx.payment.deleteMany({ where: { invoice: { tenantId } } })

      // QBO/SOLA payment tracking
      await tx.invoicePaymentIntent.deleteMany({ where: { tenantId } })
      await tx.paymentEvent.deleteMany({ where: { tenantId } })
      await tx.paymentTransaction.deleteMany({ where: { tenantId } })

      // Operational logs (keep comm history itself; these are dashboard logs/toasts)
      await tx.notification.deleteMany({ where: { tenantId } })
      await tx.activity.deleteMany({ where: { tenantId } })
      await tx.auditLog.deleteMany({ where: { tenantId } })
      await tx.dispatchEvent.deleteMany({ where: { tenantId } })
      await tx.dailyStats.deleteMany({ where: { tenantId } })
      await tx.webhookEvent.deleteMany({ where: { tenantId } })
      await tx.idempotencyKey.deleteMany({ where: { tenantId } })

      // Scheduling
      await tx.schedule.deleteMany({ where: { tenantId } })

      // Work entities
      await tx.task.deleteMany({ where: { tenantId } })
      // IssueWatchers/IssueNotes cascade from Issue; JobAssignments cascade from Job.
      await tx.issue.deleteMany({ where: { tenantId } })

      // Documents
      await tx.purchaseOrder.deleteMany({ where: { tenantId } })
      await tx.invoice.deleteMany({ where: { tenantId } })
      await tx.estimate.deleteMany({ where: { tenantId } })

      // Delete job/client addresses explicitly to avoid Address.jobId onDelete:SetNull leaving orphans.
      await tx.address.deleteMany({
        where: {
          OR: [{ job: { tenantId } }, { client: { tenantId } }],
        },
      })

      // Primary entities
      await tx.job.deleteMany({ where: { tenantId } })
      await tx.lead.deleteMany({ where: { tenantId } })

      // Catalog (wipe per user request)
      await tx.documentLineGroup.deleteMany({ where: { tenantId } })
      await tx.bundleComponent.deleteMany({ where: { tenantId } })
      await tx.bundleDefinition.deleteMany({ where: { tenantId } })
      await tx.priceBookItem.deleteMany({ where: { tenantId } })
      await tx.item.deleteMany({ where: { tenantId } })
      await tx.itemCategory.deleteMany({ where: { tenantId } })
      await tx.vendorContact.deleteMany({ where: { tenantId } })
      await tx.vendor.deleteMany({ where: { tenantId } })

      // Clients last (Invoices/Jobs already removed; contacts cascade).
      await tx.client.deleteMany({ where: { tenantId } })
    }, { timeout: 300_000 })

    console.log('Delete complete. Recounting...')
    const after = await counts()
    console.table(after)

    console.log('Factory reset finished.')
    console.log('Preserved: users + integrations + comm history')
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

