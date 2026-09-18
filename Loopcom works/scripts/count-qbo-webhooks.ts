/* eslint-disable no-console */
import { prisma } from '../lib/prisma'

async function main() {
  const total = await prisma.webhookEvent.count({ where: { provider: 'quickbooks' } })
  const recent = await prisma.webhookEvent.findMany({
    where: { provider: 'quickbooks' },
    orderBy: { receivedAt: 'desc' },
    take: 10,
    select: {
      receivedAt: true,
      eventType: true,
      processed: true,
      error: true,
      eventId: true,
    },
  })
  console.log('total_quickbooks_webhooks', total)
  console.log('recent', recent)
}

main()
  .finally(() => prisma.$disconnect())
