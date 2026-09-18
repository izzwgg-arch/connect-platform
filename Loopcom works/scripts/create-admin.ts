import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

async function main() {
  console.log('🌱 Creating admin user...')

  // Get email and password from command line args or use defaults
  const email = process.argv[2] || 'admin@trimpro.com'
  const password = process.argv[3] || 'admin123'
  const firstName = process.argv[4] || 'Admin'
  const lastName = process.argv[5] || 'User'

  try {
    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: {
        email: email,
        role: 'ADMIN',
      },
    })

    if (existingAdmin) {
      console.log(`⚠️  Admin user with email ${email} already exists!`)
      console.log('   If you want to update the password, delete the user first.')
      return
    }

    // Get or create default tenant
    let tenant = await prisma.tenant.findFirst({
      where: {
        name: 'Default Tenant',
      },
    })

    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: {
          name: 'Default Tenant',
          subdomain: 'default',
          isActive: true,
        },
      })
      console.log('✅ Created default tenant')
    } else {
      console.log('✅ Using existing tenant')
    }

    // Create admin user
    const passwordHash = await hashPassword(password)
    
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: email,
        firstName: firstName,
        lastName: lastName,
        role: 'ADMIN',
        status: 'ACTIVE',
        passwordHash: passwordHash,
        lastPasswordChange: new Date(),
      },
    })

    console.log('')
    console.log('✅ Admin user created successfully!')
    console.log('')
    console.log('📧 Login Credentials:')
    console.log(`   Email: ${email}`)
    console.log(`   Password: ${password}`)
    console.log('')
    console.log('⚠️  IMPORTANT: Change this password immediately after first login!')
    console.log('')
    console.log('Usage: tsx scripts/create-admin.ts [email] [password] [firstName] [lastName]')
  } catch (error: any) {
    console.error('❌ Error creating admin user:', error.message)
    if (error.message.includes('DATABASE_URL')) {
      console.error('')
      console.error('💡 Make sure DATABASE_URL is set in your .env file')
      console.error('   Example: DATABASE_URL="postgresql://user:password@localhost:5432/trimpro"')
    }
    process.exit(1)
  }
}

main()
  .catch((e) => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
