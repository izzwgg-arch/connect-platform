import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hashPassword } from '@/lib/auth'

// Bootstrap endpoint to create first admin user
// Call: POST /api/bootstrap/admin
// Body: { email: "admin@example.com", password: "your-password", firstName: "Admin", lastName: "User" }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password, firstName, lastName } = body

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    // Check if any admin exists
    const existingAdmin = await prisma.user.findFirst({
      where: {
        role: 'ADMIN',
      },
    })

    if (existingAdmin) {
      return NextResponse.json(
        { error: 'Admin user already exists. Please use the login page or create users through the admin panel.' },
        { status: 400 }
      )
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
    }

    // Create admin user
    const passwordHash = await hashPassword(password)
    
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: email,
        firstName: firstName || 'Admin',
        lastName: lastName || 'User',
        role: 'ADMIN',
        status: 'ACTIVE',
        passwordHash: passwordHash,
        lastPasswordChange: new Date(),
      },
    })

    return NextResponse.json({
      message: 'Admin user created successfully!',
      user: {
        id: admin.id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role,
      },
    }, { status: 201 })
  } catch (error: any) {
    console.error('Bootstrap admin error:', error)
    
    if (error.code === 'P2002') {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 400 }
      )
    }

    if (error.message?.includes('DATABASE_URL')) {
      return NextResponse.json(
        { 
          error: 'Database connection error',
          message: 'Make sure DATABASE_URL is set in your .env file and the database is running.',
          hint: 'Example: DATABASE_URL="postgresql://user:password@localhost:5432/trimpro?schema=public"'
        },
        { status: 500 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to create admin user', message: error.message },
      { status: 500 }
    )
  }
}
