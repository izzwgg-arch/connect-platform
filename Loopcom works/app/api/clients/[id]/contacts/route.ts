import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireMethodPermissions } from '@/lib/api-guards'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireMethodPermissions(request, { GET: 'clients.view' })
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    // Verify client belongs to tenant
    const client = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const contacts = await prisma.contact.findMany({
      where: { clientId: params.id },
      orderBy: [
        { isPrimary: 'desc' },
        { createdAt: 'asc' },
      ],
    })

    return NextResponse.json({ contacts })
  } catch (error) {
    console.error('Get contacts error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireMethodPermissions(request, { POST: 'clients.edit' })
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { firstName, lastName, email, phone, mobile, title, isPrimary } = body

    if (!firstName || !lastName) {
      return NextResponse.json({ error: 'First name and last name are required' }, { status: 400 })
    }

    // Verify client belongs to tenant
    const client = await prisma.client.findFirst({
      where: {
        id: params.id,
        tenantId: user.tenantId,
      },
    })

    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // If this is set as primary, unset other primary contacts
    if (isPrimary) {
      await prisma.contact.updateMany({
        where: { clientId: params.id, isPrimary: true },
        data: { isPrimary: false },
      })
    }

    const contact = await prisma.contact.create({
      data: {
        clientId: params.id,
        firstName,
        lastName,
        email: email || null,
        phone: phone || null,
        mobile: mobile || null,
        title: title || null,
        isPrimary: isPrimary || false,
      },
    })

    return NextResponse.json({ contact }, { status: 201 })
  } catch (error) {
    console.error('Create contact error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
