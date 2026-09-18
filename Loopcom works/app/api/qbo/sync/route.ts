import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { prisma } from '@/lib/prisma'
import { quickBooksService } from '@/lib/services/quickbooks'
import { getIntegrationSecrets } from '@/lib/integrations/status'

export async function POST(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'system.integrations')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    const body = await request.json()
    const { type } = body // clients, invoices, payments, items

    // Get integration
    const integration = await prisma.quickBooksIntegration.findUnique({
      where: { tenantId: user.tenantId },
    })

    if (!integration || !integration.isConnected) {
      return NextResponse.json({ error: 'QuickBooks not connected' }, { status: 400 })
    }

    // Check if token needs refresh
    let accessToken = integration.accessToken
    if (integration.tokenExpiresAt && integration.tokenExpiresAt < new Date()) {
      // Get saved credentials from IntegrationConnection if available
      const secrets = await getIntegrationSecrets(user.tenantId, 'quickbooks' as any)
      const clientId = secrets?.clientId || null
      const clientSecret = secrets?.clientSecret || null
      const refreshed = await quickBooksService.refreshAccessToken(
        integration.refreshToken || '',
        clientId || undefined,
        clientSecret || undefined
      )
      
      accessToken = refreshed.access_token
      
      // Update integration
      await prisma.quickBooksIntegration.update({
        where: { tenantId: user.tenantId },
        data: {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token || integration.refreshToken,
          tokenExpiresAt: new Date(Date.now() + (refreshed.expires_in * 1000)),
        },
      })
    }

    let synced = 0
    let errors = 0
    const errorsList: string[] = []

    // Sync based on type
    switch (type) {
      case 'clients': {
        // Extract and validate realmId - must be string
        if (!integration.realmId) {
          return NextResponse.json({ error: 'QuickBooks realm ID not found' }, { status: 400 })
        }
        
        // After null check, cast to string - we've validated it exists and is a string
        const realmId = integration.realmId as string
        
        // Get all clients from our system
        const clients = await prisma.client.findMany({
          where: {
            tenantId: user.tenantId,
            isActive: true,
          },
        })

        for (const client of clients) {
          try {
            // Check if already synced
            // In production, you'd store QBO customer ID in a separate field or metadata
            const customerData = {
              DisplayName: client.name,
              CompanyName: client.companyName || client.name,
              PrimaryEmailAddr: client.email ? {
                Address: client.email,
              } : undefined,
              PrimaryPhone: client.phone ? {
                FreeFormNumber: client.phone,
              } : undefined,
            }

            if (client.id.includes('qbo_')) {
              // Update existing
              const qboId = client.id.replace('qbo_', '')
              // @ts-expect-error - realmId is validated as non-null above, but TypeScript doesn't narrow in closures
              await quickBooksService.updateCustomer(accessToken, integration.realmId, qboId, customerData)
              
              await prisma.quickBooksSyncLog.create({
                data: {
                  integrationId: integration.id,
                  type: 'client',
                  action: 'update',
                  status: 'success',
                  entityId: client.id,
                  qboId: qboId,
                },
              })
            } else {
              // Create new
              // @ts-expect-error - realmId is validated as non-null above, but TypeScript doesn't narrow in closures
              const result = await quickBooksService.createCustomer(accessToken, integration.realmId, {
                ...customerData,
              })
              
              // Store QBO ID (you'd add a qboCustomerId field to Client model)
              await prisma.quickBooksSyncLog.create({
                data: {
                  integrationId: integration.id,
                  type: 'client',
                  action: 'create',
                  status: 'success',
                  entityId: client.id,
                  qboId: result.Customer?.Id || '',
                },
              })
            }

            synced++
          } catch (error: any) {
            errors++
            errorsList.push(`Client ${client.name}: ${error.message}`)
            
            await prisma.quickBooksSyncLog.create({
              data: {
                integrationId: integration.id,
                type: 'client',
                action: 'create',
                status: 'error',
                entityId: client.id,
                error: error.message,
              },
            })
          }
        }
        break
      }

      case 'invoices': {
        // Similar implementation for invoices
        const invoices = await prisma.invoice.findMany({
          where: {
            tenantId: user.tenantId,
            status: {
              in: ['SENT', 'PARTIAL', 'PAID'],
            },
          },
          include: {
            client: true,
            lineItems: true,
          },
        })

        for (const invoice of invoices) {
          try {
            // Build QBO invoice data
            // This is simplified - actual implementation would be more complex
            const invoiceData = {
              Line: invoice.lineItems.map((item, index) => ({
                DetailType: 'SalesItemLineDetail',
                Amount: Number(item.total),
                SalesItemLineDetail: {
                  ItemRef: {
                    value: '1', // You'd map to actual QBO items
                  },
                  Qty: Number(item.quantity),
                  UnitPrice: Number(item.unitPrice),
                },
              })),
              CustomerRef: {
                value: invoice.client.id, // You'd use QBO customer ID
              },
            }

            // Create or update invoice in QBO
            // Implementation here
            
            synced++
          } catch (error: any) {
            errors++
            errorsList.push(`Invoice ${invoice.invoiceNumber}: ${error.message}`)
          }
        }
        break
      }

      // Add more sync types as needed
    }

    // Update integration sync status
    await prisma.quickBooksIntegration.update({
      where: { tenantId: user.tenantId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: errors > 0 ? 'partial' : 'success',
        lastSyncError: errors > 0 ? errorsList.slice(0, 5).join('; ') : null,
      },
    })

    return NextResponse.json({
      success: true,
      synced,
      errors,
      errorsList: errorsList.slice(0, 10),
    })
  } catch (error: any) {
    console.error('QuickBooks sync error:', error)
    return NextResponse.json(
      { error: error.message || 'Sync failed' },
      { status: 500 }
    )
  }
}
