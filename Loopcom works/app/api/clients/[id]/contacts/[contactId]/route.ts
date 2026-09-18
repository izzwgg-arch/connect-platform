import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requireMethodPermissions } from '@/lib/api-guards'
import { prisma } from '@/lib/prisma'

async function getTenantContact(clientId: string, contactId: string, tenantId: string) {
  return prisma.contact.findFirst({
    where: {
      id: contactId,
      clientId,
      client: { tenantId },
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; contactId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireMethodPermissions(request, { PATCH: 'clients.edit' })
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const contact = await getTenantContact(params.id, params.contactId, user.tenantId)
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const body = await request.json()
    const { firstName, lastName, email, phone, mobile, title, isPrimary } = body

    if (firstName !== undefined && !String(firstName).trim()) {
      return NextResponse.json({ error: 'First name is required' }, { status: 400 })
    }
    if (lastName !== undefined && !String(lastName).trim()) {
      return NextResponse.json({ error: 'Last name is required' }, { status: 400 })
    }

    if (isPrimary === true) {
      await prisma.contact.updateMany({
        where: { clientId: params.id, isPrimary: true, id: { not: params.contactId } },
        data: { isPrimary: false },
      })
    }

    const updated = await prisma.contact.update({
      where: { id: params.contactId },
      data: {
        firstName: firstName !== undefined ? String(firstName).trim() : undefined,
        lastName: lastName !== undefined ? String(lastName).trim() : undefined,
        email: email !== undefined ? (String(email).trim() || null) : undefined,
        phone: phone !== undefined ? (String(phone).trim() || null) : undefined,
        mobile: mobile !== undefined ? (String(mobile).trim() || null) : undefined,
        title: title !== undefined ? (String(title).trim() || null) : undefined,
        isPrimary: isPrimary !== undefined ? Boolean(isPrimary) : undefined,
      },
    })

    return NextResponse.json({ contact: updated })
  } catch (error) {
    console.error('Update contact error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; contactId: string } }
) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requireMethodPermissions(request, { DELETE: 'clients.edit' })
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const contact = await getTenantContact(params.id, params.contactId, user.tenantId)
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    await prisma.contact.delete({ where: { id: params.contactId } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete contact error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
