const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function checkMedia() {
  try {
    const media = await prisma.messageMedia.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: { message: { select: { id: true, body: true } } },
    })
    
    console.log('\n=== Latest 5 Media Records ===\n')
    media.forEach((m, i) => {
      console.log(`\n[${i + 1}] ID: ${m.id}`)
      console.log(`    URL: ${m.url}`)
      console.log(`    URL Length: ${m.url.length}`)
      console.log(`    Filename: ${m.filename}`)
      console.log(`    Type: ${m.type}`)
      console.log(`    Message Body: ${m.message.body?.substring(0, 50) || '(empty)'}`)
      console.log(`    Created: ${m.createdAt}`)
    })
    
    await prisma.$disconnect()
  } catch (error) {
    console.error('Error:', error)
    await prisma.$disconnect()
    process.exit(1)
  }
}

checkMedia()
