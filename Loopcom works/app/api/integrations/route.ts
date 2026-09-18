import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getAuthUser } from '@/lib/middleware'
import { requirePermission } from '@/lib/authorization'
import { getIntegrationConnections } from '@/lib/integrations/status'
import { getAllIntegrations } from '@/lib/integrations/registry'

export async function GET(request: NextRequest) {
  const authError = await authenticateRequest(request)
  if (authError) return authError
  const permError = await requirePermission(request, 'settings.view')
  if (permError) return permError

  const user = getAuthUser(request)

  try {
    // Get all integrations first (this should always work)
    const allIntegrations = getAllIntegrations()
    
    console.log('All integrations from registry:', allIntegrations.length)
    console.log('Providers:', allIntegrations.map(i => i.provider).join(', '))
    
    if (!allIntegrations || allIntegrations.length === 0) {
      console.error('ERROR: getAllIntegrations returned empty array!')
      return NextResponse.json({ 
        error: 'No integrations found in registry',
        integrations: []
      })
    }

    // Get connections - don't fail if table doesn't exist yet
    let connections: any[] = []
    try {
      connections = await getIntegrationConnections(user.tenantId)
    } catch (error: any) {
      console.warn('Could not fetch integration connections (table may not exist yet):', error.message)
      // Continue with empty connections array - integrations will still show
      connections = []
    }

    // Merge integrations with their connection status
    const integrations = allIntegrations.map((integration) => {
      const connection = connections.find((c) => c.provider === integration.provider)
      return {
        ...integration,
        connection: connection
          ? {
              id: connection.id,
              status: connection.status,
              displayName: connection.displayName,
              lastCheckedAt: connection.lastCheckedAt?.toISOString() || null,
              lastError: connection.lastError,
              createdAt: connection.createdAt.toISOString(),
            }
          : null,
      }
    })

    console.log('Returning integrations:', integrations.length)
    return NextResponse.json({ integrations })
  } catch (error: any) {
    console.error('Get integrations error:', error)
    console.error('Error stack:', error?.stack)
    return NextResponse.json({ 
      error: 'Internal server error',
      message: error.message || 'Unknown error'
    }, { status: 500 })
  }
}
