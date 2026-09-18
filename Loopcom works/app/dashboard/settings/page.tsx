'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { User, Bell, Link as LinkIcon, Users, Palette } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type UserNotificationPreferences,
} from '@/lib/notifications/preferences'

const PREF_ROWS: Array<{
  key: keyof UserNotificationPreferences
  title: string
  description: string
}> = [
  {
    key: 'emailNotifications',
    title: 'Email Notifications',
    description: 'Also send in-app alerts to your account email (off by default)',
  },
  {
    key: 'newJobAssigned',
    title: 'New Job Assigned',
    description: 'When a job is assigned to you',
  },
  {
    key: 'jobStatusChanges',
    title: 'Job Updates',
    description: 'When a job you are on changes status or schedule',
  },
  {
    key: 'requestStatusChanges',
    title: 'Request Updates',
    description: 'When a request you created or are assigned to changes',
  },
  {
    key: 'newMessage',
    title: 'New Messages',
    description: 'When you receive a chat or job message',
  },
  {
    key: 'paymentReceived',
    title: 'Payment Alerts',
    description: 'When a payment is received',
  },
]

export default function SettingsPage() {
  const router = useRouter()
  const pathname = usePathname()
  const [prefs, setPrefs] = useState<UserNotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES)
  const [prefsLoading, setPrefsLoading] = useState(false)
  const [prefsSaving, setPrefsSaving] = useState(false)
  const [prefsMessage, setPrefsMessage] = useState<string | null>(null)

  const getActiveTab = () => {
    if (pathname?.includes('/settings/branding')) return 'branding'
    if (pathname?.includes('/settings/integrations')) return 'integrations'
    if (pathname?.includes('/settings/roles')) return 'roles'
    return 'profile'
  }

  const [activeTab, setActiveTab] = useState(getActiveTab())

  useEffect(() => {
    setActiveTab(getActiveTab())
  }, [pathname])

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }, [])

  const loadPreferences = useCallback(async () => {
    setPrefsLoading(true)
    setPrefsMessage(null)
    try {
      const response = await fetch('/api/notifications/preferences', {
        headers: authHeaders(),
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Failed to load preferences')
      const data = await response.json()
      setPrefs({ ...DEFAULT_NOTIFICATION_PREFERENCES, ...(data.preferences || {}) })
    } catch (error) {
      console.error(error)
      setPrefsMessage('Could not load notification preferences.')
    } finally {
      setPrefsLoading(false)
    }
  }, [authHeaders])

  useEffect(() => {
    if (activeTab === 'notifications') {
      void loadPreferences()
    }
  }, [activeTab, loadPreferences])

  const savePreferences = async () => {
    setPrefsSaving(true)
    setPrefsMessage(null)
    try {
      const response = await fetch('/api/notifications/preferences', {
        method: 'PATCH',
        headers: authHeaders(),
        credentials: 'include',
        body: JSON.stringify({ preferences: prefs }),
      })
      if (!response.ok) throw new Error('Failed to save preferences')
      const data = await response.json()
      setPrefs({ ...DEFAULT_NOTIFICATION_PREFERENCES, ...(data.preferences || prefs) })
      setPrefsMessage('Preferences saved.')
    } catch (error) {
      console.error(error)
      setPrefsMessage('Could not save preferences.')
    } finally {
      setPrefsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
        <p className="mt-2 text-gray-600">Manage your account settings and preferences</p>
      </div>

      <div className="flex space-x-4 border-b">
        <button
          onClick={() => setActiveTab('profile')}
          className={`px-4 py-2 border-b-2 ${
            activeTab === 'profile'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <User className="inline mr-2 h-4 w-4" />
          Profile
        </button>
        <button
          onClick={() => setActiveTab('notifications')}
          className={`px-4 py-2 border-b-2 ${
            activeTab === 'notifications'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <Bell className="inline mr-2 h-4 w-4" />
          Notifications
        </button>
        <button
          onClick={() => router.push('/dashboard/settings/integrations')}
          className={`px-4 py-2 border-b-2 ${
            activeTab === 'integrations'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <LinkIcon className="inline mr-2 h-4 w-4" />
          Integrations
        </button>
        <button
          onClick={() => router.push('/dashboard/settings/roles')}
          className={`px-4 py-2 border-b-2 ${
            activeTab === 'roles'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <Users className="inline mr-2 h-4 w-4" />
          Roles & Permissions
        </button>
        <button
          onClick={() => router.push('/dashboard/settings/branding')}
          className={`px-4 py-2 border-b-2 ${
            activeTab === 'branding'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          <Palette className="inline mr-2 h-4 w-4" />
          Branding
        </button>
        <button
          onClick={() => setActiveTab('security')}
          className={`px-4 py-2 border-b-2 ${
            activeTab === 'security'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 hover:text-gray-900'
          }`}
        >
          Security
        </button>
      </div>

      {activeTab === 'profile' && (
        <Card>
          <CardHeader>
            <CardTitle>Profile Information</CardTitle>
            <CardDescription>Update your personal information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="firstName">First Name</Label>
                <Input id="firstName" placeholder="John" />
              </div>
              <div>
                <Label htmlFor="lastName">Last Name</Label>
                <Input id="lastName" placeholder="Doe" />
              </div>
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="john@example.com" />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" type="tel" placeholder="(555) 123-4567" />
            </div>
            <Button>Save Changes</Button>
          </CardContent>
        </Card>
      )}

      {activeTab === 'notifications' && (
        <Card>
          <CardHeader>
            <CardTitle>Notification Preferences</CardTitle>
            <CardDescription>
              Choose which alerts you get in-app/push, and whether they are also emailed
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {prefsLoading ? (
              <p className="text-sm text-gray-500">Loading preferences...</p>
            ) : (
              PREF_ROWS.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium">{row.title}</p>
                    <p className="text-sm text-gray-500">{row.description}</p>
                  </div>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={Boolean(prefs[row.key])}
                    onChange={(event) =>
                      setPrefs((prev) => ({ ...prev, [row.key]: event.target.checked }))
                    }
                  />
                </div>
              ))
            )}
            {prefsMessage ? <p className="text-sm text-gray-600">{prefsMessage}</p> : null}
            <Button onClick={() => void savePreferences()} disabled={prefsLoading || prefsSaving}>
              {prefsSaving ? 'Saving...' : 'Save Preferences'}
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === 'security' && (
        <Card>
          <CardHeader>
            <CardTitle>Security Settings</CardTitle>
            <CardDescription>Manage your password and security preferences</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input id="currentPassword" type="password" />
            </div>
            <div>
              <Label htmlFor="newPassword">New Password</Label>
              <Input id="newPassword" type="password" />
            </div>
            <div>
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input id="confirmPassword" type="password" />
            </div>
            <Button>Update Password</Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
