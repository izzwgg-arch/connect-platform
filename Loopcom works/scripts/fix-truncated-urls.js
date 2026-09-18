const { PrismaClient } = require('@prisma/client')
const path = require('path')
const fs = require('fs').promises
const prisma = new PrismaClient()

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://app.trimprony.com'
const UPLOADS_DIR = path.join(process.cwd(), 'public', 'uploads')

async function fixTruncatedUrls() {
  try {
    console.log('Finding media records with truncated URLs...')
    
    // Find all media records
    const allMedia = await prisma.messageMedia.findMany({
      include: {
        message: {
          include: {
            conversation: true
          }
        }
      }
    })
    
    console.log(`Found ${allMedia.length} media records`)
    
    let fixed = 0
    let notFound = 0
    let alreadyCorrect = 0
    
    for (const media of allMedia) {
      const tenantId = media.message.conversation.tenantId
      const filename = media.filename || media.url.split('/').pop()
      
      // Construct correct URL
      const correctUrl = `${PUBLIC_APP_URL}/uploads/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`
      
      // Check if URL is truncated (exactly 100 chars or doesn't match pattern)
      if (media.url.length === 100 || !media.url.includes('/uploads/') || !media.url.endsWith(filename)) {
        // Check if file exists
        const filePath = path.join(UPLOADS_DIR, tenantId, filename)
        try {
          await fs.access(filePath)
          
          // Update the URL
          await prisma.messageMedia.update({
            where: { id: media.id },
            data: { url: correctUrl }
          })
          
          console.log(`✓ Fixed: ${media.id}`)
          console.log(`  Old: ${media.url}`)
          console.log(`  New: ${correctUrl}`)
          fixed++
        } catch (err) {
          console.log(`✗ File not found: ${filename}`)
          notFound++
        }
      } else {
        alreadyCorrect++
      }
    }
    
    console.log(`\n=== Summary ===`)
    console.log(`Fixed: ${fixed}`)
    console.log(`Not found: ${notFound}`)
    console.log(`Already correct: ${alreadyCorrect}`)
    
    await prisma.$disconnect()
  } catch (error) {
    console.error('Error:', error)
    await prisma.$disconnect()
    process.exit(1)
  }
}

fixTruncatedUrls()
