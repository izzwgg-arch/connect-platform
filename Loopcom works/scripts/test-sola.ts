import { prisma } from '@/lib/prisma'
import { getIntegrationSecrets } from '@/lib/integrations/status'
import { testSola } from '@/lib/integrations/providers/sola'

async function main() {
  const connections = await prisma.integrationConnection.findMany({
    where: { provider: 'sola' },
    select: { tenantId: true, status: true, displayName: true },
  })

  if (connections.length === 0) {
    console.log('No SOLA integration connections found.')
    return
  }

  let failed = 0
  for (const conn of connections) {
    const secrets = await getIntegrationSecrets(conn.tenantId, 'sola')
    const result = await testSola(secrets || {})
    const label = conn.displayName ? `${conn.displayName} (${conn.tenantId})` : conn.tenantId
    console.log(`[SOLA] ${label} status=${conn.status} -> ${result.success ? 'OK' : 'FAIL'}: ${result.message}${result.error ? ` (${result.error})` : ''}`)
    if (!result.success) failed++
  }

  if (failed > 0) {
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error('test-sola failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

