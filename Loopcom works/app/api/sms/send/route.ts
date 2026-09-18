import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { voipMsService } from '@/lib/services/voipms'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'messages.send')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const {
      toNumber,
      message,
      clientId,
      contactId,
      jobId,
      leadId,
      did,
    } = body

    if (!toNumber || !message) {
      return NextResponse.json({ error: 'To number and message are required' }, { status: 400 })
    }

    // Send SMS via VoIP.ms
    let voipMsMessageId: string | null = null
    try {
      const result = await voipMsService.sendSMS({
        did: did || process.env.VOIPMS_DID || '',
        dst: toNumber,
        message,
      })
      voipMsMessageId = result.sms?.id || null
    } catch (error: any) {
      console.error('VoIP.ms SMS send error:', error)
      // Continue to create record even if send fails
    }

    // Create SMS record
    const sms = await prisma.smsMessage.create({
      data: {
        tenantId: user.tenantId,
        direction: 'OUTBOUND',
        status: voipMsMessageId ? 'SENT' : 'FAILED',
        fromNumber: process.env.VOIPMS_DID || '',
        toNumber,
        body: message,
        voipmsMessageId: voipMsMessageId,
        userId: user.id,
        clientId: clientId || null,
        contactId: contactId || null,
        jobId: jobId || null,
        leadId: leadId || null,
        sentAt: new Date(),
      },
      include: {
        client: true,
        contact: true,
        job: true,
      },
    })

    // Create activity
    await prisma.activity.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        type: 'EMAIL_SENT', // Placeholder, would add SMS_SENT
        description: `SMS sent to ${toNumber}`,
        clientId: clientId || undefined,
        jobId: jobId || undefined,
        leadId: leadId || undefined,
      },
    })

    return NextResponse.json({ sms }, { status: 201 })
  } catch (error) {
    console.error('Send SMS error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
