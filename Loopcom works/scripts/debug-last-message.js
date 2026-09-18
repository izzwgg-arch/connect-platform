/**
 * Debug: print last outbound message + media for a tenant (no secrets).
 * Run on server: node scripts/debug-last-message.js <tenantId>
 */

const { PrismaClient } = require('@prisma/client')

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) {
    console.error('Usage: node scripts/debug-last-message.js <tenantId>')
    process.exit(2)
  }

  const prisma = new PrismaClient()
  try {
    const msg = await prisma.message.findFirst({
      where: { tenantId, direction: 'OUTBOUND' },
      orderBy: { createdAt: 'desc' },
      include: { media: true, conversation: { select: { id: true, channel: true } } },
    })

    const msgWithMedia = await prisma.message.findFirst({
      where: { tenantId, direction: 'OUTBOUND', media: { some: {} } },
      orderBy: { createdAt: 'desc' },
      include: { media: true, conversation: { select: { id: true, channel: true } } },
    })

    if (!msg) {
      console.log(JSON.stringify({ ok: false, error: 'No outbound messages found' }))
      return
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          id: msg.id,
          createdAt: msg.createdAt,
          channel: msg.channel,
          conversationId: msg.conversationId,
          conversationChannel: msg.conversation?.channel,
          provider: msg.provider,
          providerMessageId: msg.providerMessageId,
          status: msg.status,
          errorMessage: msg.errorMessage,
          to: msg.toNumber,
          from: msg.fromNumber,
          bodyPreview: msg.body ? String(msg.body).slice(0, 80) : null,
          media: (msg.media || []).map((m) => ({
            id: m.id,
            type: m.type,
            url: m.url,
            mimeType: m.mimeType,
            filename: m.filename,
          })),
          latestOutboundWithMedia: msgWithMedia
            ? {
                id: msgWithMedia.id,
                createdAt: msgWithMedia.createdAt,
                channel: msgWithMedia.channel,
                provider: msgWithMedia.provider,
                to: msgWithMedia.toNumber,
                bodyPreview: msgWithMedia.body ? String(msgWithMedia.body).slice(0, 80) : null,
                media: msgWithMedia.media.map((m) => ({
                  type: m.type,
                  url: m.url,
                  mimeType: m.mimeType,
                  filename: m.filename,
                })),
              }
            : null,
        },
        null,
        2
      )
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

