import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.quickBooksSyncLog.findMany({
  where: { status: 'error' },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { type: true, entityId: true, error: true, createdAt: true },
})
console.log(JSON.stringify(rows, null, 2))
await p.$disconnect()
