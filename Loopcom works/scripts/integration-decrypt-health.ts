import { prisma } from '../lib/prisma'
import { decryptSecrets } from '../lib/integrations/secrets'

async function main() {
  const rows = await prisma.integrationConnection.findMany({
    where: {
      encryptedSecrets: {
        not: null,
      },
    },
    select: {
      id: true,
      tenantId: true,
      provider: true,
      encryptedSecrets: true,
    },
  })

  let ok = 0
  let failed = 0
  const failedRows: Array<{ id: string; tenantId: string; provider: string; error: string }> = []

  for (const row of rows) {
    try {
      decryptSecrets(String(row.encryptedSecrets || ''))
      ok += 1
    } catch (error: any) {
      failed += 1
      failedRows.push({
        id: row.id,
        tenantId: row.tenantId,
        provider: String(row.provider),
        error: String(error?.message || 'decrypt_failed'),
      })
    }
  }

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        totalEncryptedConnections: rows.length,
        ok,
        failed,
      },
      null,
      2
    )
  )

  if (failed > 0) {
    console.error('INTEGRATION DECRYPT HEALTH FAILED:')
    for (const row of failedRows) {
      console.error(`- provider=${row.provider} tenant=${row.tenantId} id=${row.id} error=${row.error}`)
    }
    process.exit(1)
  }
}

main()
  .catch((error) => {
    console.error('INTEGRATION DECRYPT HEALTH ERROR:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
