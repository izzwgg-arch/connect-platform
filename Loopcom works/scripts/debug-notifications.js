/**
 * Debug: show recent notifications for a tenant and per-user counts (no secrets).
 *
 * Usage (server):
 *   node scripts/debug-notifications.js <tenantId>
 */

const { PrismaClient } = require('@prisma/client')

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) {
    console.error('Usage: node scripts/debug-notifications.js <tenantId>')
    process.exit(2)
  }

  const prisma = new PrismaClient()
  try {
    const total = await prisma.notification.count({ where: { tenantId } })
    const last = await prisma.notification.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        userId: true,
        status: true,
        type: true,
        title: true,
        createdAt: true,
        linkUrl: true,
      },
    })

    const grouped = await prisma.notification.groupBy({
      by: ['userId', 'status'],
      where: { tenantId },
      _count: { _all: true },
    })

    console.log(JSON.stringify({ tenantId, total, grouped, last }, null, 2))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

