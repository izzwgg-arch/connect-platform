'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Mail, MessageSquare, MessageCircle, DollarSign, CreditCard, CheckCircle, XCircle, Clock, AlertCircle, Settings as SettingsIcon, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { formatDate } from '@/lib/utils'

interface Integration {
  provider: string
  name: string
  description: string
  icon: string
  category: string
  connection: {
    id: string
    status: string
    displayName: string | null
    lastCheckedAt: string | null
    lastError: string | null
    createdAt: string
  } | null
}

const iconMap: Record<string, any> = {
  Mail,
  MessageSquare,
  MessageCircle,
  DollarSign,
  CreditCard,
}

const statusColors: Record<string, string> = {
  NOT_CONFIGURED: 'bg-gray-100 text-gray-800',
  CONNECTED: 'bg-green-100 text-green-800',
  ERROR: 'bg-red-100 text-red-800',
  CONNECTING: 'bg-yellow-100 text-yellow-800',
}

const statusIcons: Record<string, any> = {
  NOT_CONFIGURED: SettingsIcon,
  CONNECTED: CheckCircle,
  ERROR: XCircle,
  CONNECTING: Clock,
}

export default function IntegrationsPage() {
  const router = useRouter()
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchIntegrations()
  }, [])

  const fetchIntegrations = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      if (!token) {
        router.push('/auth/login')
        return
      }

      const response = await fetch('/api/integrations', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        router.push('/auth/login')
        return
      }

      if (response.ok) {
        const data = await response.json()
        const providers = data.integrations?.map((i: any) => i.provider) || []
        console.log('Fetched integrations:', providers)
        console.log('Total integrations:', providers.length)
        console.log('Full response:', JSON.stringify(data, null, 2))
        
        // Force include WhatsApp if missing
        if (!providers.includes('whatsapp')) {
          console.error('WhatsApp missing from integrations! Expected 5, got:', providers.length)
          console.error('Received providers:', providers.join(', '))
        }
        
        setIntegrations(data.integrations || [])
      } else {
        const errorText = await response.text()
        console.error('Failed to fetch integrations:', response.status, errorText)
        const errorData = JSON.parse(errorText || '{}')
        console.error('Error details:', errorData)
        alert(`Failed to load integrations: ${errorData.error || 'Unknown error'}. Check console for details.`)
      }
    } catch (error) {
      console.error('Failed to fetch integrations:', error)
    } finally {
      setLoading(false)
    }
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'NOT_CONFIGURED':
        return 'Not Configured'
      case 'CONNECTED':
        return 'Connected'
      case 'ERROR':
        return 'Error'
      case 'CONNECTING':
        return 'Connecting'
      default:
        return status
    }
  }

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'communication':
        return 'Communication'
      case 'financial':
        return 'Financial'
      case 'payment':
        return 'Payment'
      case 'accounting':
        return 'Accounting'
      default:
        return category
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading integrations...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Integrations</h1>
          <p className="mt-1 text-gray-600">Connect external services to enhance Trim Pro</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/settings/email-integrations">
            <Button>
              <Mail className="mr-2 h-4 w-4" />
              Email Integrations
            </Button>
          </Link>
          <Link href="/dashboard/settings">
            <Button variant="outline">
              <ArrowRight className="mr-2 h-4 w-4" />
              Back to Settings
            </Button>
          </Link>
        </div>
      </div>

      {integrations.length === 0 && !loading && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-gray-600">No integrations found. Please refresh the page.</p>
            <p className="text-center text-xs text-gray-500 mt-2">Expected 5 integrations: Email, VoIP.ms SMS & MMS, WhatsApp, QuickBooks, Sola</p>
          </CardContent>
        </Card>
      )}

      {integrations.length > 0 && integrations.length < 5 && (
        <Card className="border-yellow-200 bg-yellow-50">
          <CardContent className="pt-6">
            <p className="text-center text-yellow-800">
              Warning: Expected 5 integrations but found {integrations.length}. Providers: {integrations.map(i => i.provider).join(', ')}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {integrations.map((integration) => {
          // Debug log for each integration
          console.log('Rendering integration:', integration.provider, integration.name)
          const IconComponent = iconMap[integration.icon] || SettingsIcon
          const StatusIcon = integration.connection
            ? statusIcons[integration.connection.status] || AlertCircle
            : SettingsIcon
          const status = integration.connection?.status || 'NOT_CONFIGURED'

          return (
            <Card key={integration.provider} className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="p-2 bg-gray-100 rounded-lg">
                      <IconComponent className="h-6 w-6 text-gray-700" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{integration.name}</CardTitle>
                      <p className="text-xs text-gray-500 mt-1">{getCategoryLabel(integration.category)}</p>
                    </div>
                  </div>
                  <StatusIcon
                    className={`h-5 w-5 ${
                      status === 'CONNECTED'
                        ? 'text-green-600'
                        : status === 'ERROR'
                        ? 'text-red-600'
                        : 'text-gray-400'
                    }`}
                  />
                </div>
                <CardDescription className="mt-2">{integration.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        statusColors[status] || 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {getStatusLabel(status)}
                    </span>
                  </div>

                  {integration.connection && (
                    <>
                      {integration.connection.lastCheckedAt && (
                        <div className="text-xs text-gray-500">
                          Last checked: {formatDate(integration.connection.lastCheckedAt)}
                        </div>
                      )}
                      {integration.connection.lastError && (
                        <div className="text-xs text-red-600 line-clamp-2">
                          {integration.connection.lastError}
                        </div>
                      )}
                    </>
                  )}

                  <Link href={`/dashboard/settings/integrations/${integration.provider}`}>
                    <Button className="w-full" variant={status === 'CONNECTED' ? 'outline' : 'default'}>
                      {status === 'CONNECTED' ? 'Manage' : status === 'NOT_CONFIGURED' ? 'Configure' : 'Reconnect'}
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
