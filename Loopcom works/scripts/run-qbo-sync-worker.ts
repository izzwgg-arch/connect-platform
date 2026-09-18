import { prisma } from '../lib/prisma'
import { runQboSyncWorker } from '../lib/qbo/sync-queue'

async function main() {
  const result = await runQboSyncWorker({ limit: Number(process.env.QBO_SYNC_WORKER_LIMIT || 50) })
  console.log(JSON.stringify({ ok: true, ranAt: new Date().toISOString(), ...result }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

