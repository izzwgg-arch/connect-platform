const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function checkMessage() {
  try {
    // Find the latest message with media
    const message = await prisma.message.findFirst({
      where: {
        media: { some: {} }
      },
      include: {
        media: true
      },
      orderBy: { createdAt: 'desc' },
      take: 1
    })
    
    if (message) {
      console.log('Latest message with media:')
      console.log({
        id: message.id,
        body: message.body,
        bodyLength: message.body?.length || 0,
        mediaCount: message.media.length,
        media: message.media.map(m => ({
          id: m.id,
          url: m.url,
          urlLength: m.url.length,
          filename: m.filename
        }))
      })
    } else {
      console.log('No messages with media found')
    }
    
    await prisma.$disconnect()
  } catch (error) {
    console.error('Error:', error)
    await prisma.$disconnect()
    process.exit(1)
  }
}

checkMessage()
