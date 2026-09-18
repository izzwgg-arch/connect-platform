const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function checkMedia() {
  try {
    const media = await prisma.messageMedia.findMany({
      where: { url: { contains: '042e0726' } },
      include: { message: true },
      take: 5,
      orderBy: { createdAt: 'desc' },
    })
    
    console.log('Found media records:')
    media.forEach(m => {
      console.log({
        id: m.id,
        url: m.url,
        filename: m.filename,
        type: m.type,
        messageId: m.messageId,
        messageBody: m.message.body?.substring(0, 50),
      })
    })
    
    await prisma.$disconnect()
  } catch (error) {
    console.error('Error:', error)
    await prisma.$disconnect()
    process.exit(1)
  }
}

checkMedia()
