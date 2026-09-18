/**
 * Debug helper (safe): prints whether voipms_sms/webwhatis integrations can be decrypted,
 * without printing secrets.
 *
 * Usage on server:
 *   node debug_integrations.js
 */

const { PrismaClient } = require('@prisma/client')
const { decryptSecrets } = require('./lib/integrations/secrets')

const prisma = new PrismaClient()

async function main() {
  const rows = await prisma.integrationConnection.findMany({
    where: { provider: { in: ['voipms_sms', 'webwhatis'] } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      provider: true,
      status: true,
      tenantId: true,
      encryptedSecrets: true,
      updatedAt: true,
    },
  })

  for (const r of rows) {
    let s = null
    let decryptOk = false
    try {
      s = decryptSecrets(r.encryptedSecrets || '')
      decryptOk = true
    } catch {
      decryptOk = false
    }

    const safe = {
      tenantId: r.tenantId,
      provider: r.provider,
      status: r.status,
      updatedAt: r.updatedAt,
      decryptOk,
      voip:
        r.provider === 'voipms_sms'
          ? {
              usernamePresent: !!(s && s.username),
              apiPasswordLen: s && s.apiPassword ? String(s.apiPassword).length : 0,
              defaultDid: s && s.defaultDid ? String(s.defaultDid) : null,
            }
          : undefined,
      webwhatis:
        r.provider === 'webwhatis'
          ? {
              apiKeyLen: s && s.apiKey ? String(s.apiKey).length : 0,
            }
          : undefined,
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(safe))
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

