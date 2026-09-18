'use client'

import { useState, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { TrimProLoginBadge } from '@/components/branding/TrimProLogo'
import { isDevEnvironment } from '@/lib/dev'

type LoginResponse = {
  accessToken: string
  refreshToken: string
  user: Record<string, unknown>
}

const LOGIN_TIMEOUT_MS = 30_000

async function postJsonWithTimeout(url: string, body?: unknown) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS)

  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function loginFetchErrorMessage(err: unknown, action: 'Login' | 'Dev login') {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return `${action} timed out. Check that the dev server is running and try again.`
  }
  return 'An error occurred. Please try again.'
}

function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devLoading, setDevLoading] = useState(false)
  const showDevLogin = isDevEnvironment()

  const storeSessionAndRedirect = (data: LoginResponse) => {
    localStorage.setItem('accessToken', data.accessToken)
    localStorage.setItem('refreshToken', data.refreshToken)
    localStorage.setItem('user', JSON.stringify(data.user))
    // Hard navigation avoids a stuck "Signing in..." if client routing hangs.
    window.location.assign('/dashboard')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await postJsonWithTimeout('/api/auth/login', {
        email,
        password,
        clientType: 'web',
      })

      const data = await response.json()

      if (!response.ok) {
        if (data.requiresPasswordChange) {
          // Redirect to set password page
          router.push(`/auth/set-password?userId=${data.userId}`)
          return
        }
        setError(data.error || 'Login failed')
        return
      }

      storeSessionAndRedirect(data)
    } catch (err) {
      setError(loginFetchErrorMessage(err, 'Login'))
    } finally {
      setLoading(false)
    }
  }

  const handleDevLogin = async () => {
    setError('')
    setDevLoading(true)

    try {
      const response = await postJsonWithTimeout('/api/auth/dev-login')

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Dev login failed')
        return
      }

      storeSessionAndRedirect(data)
    } catch (err) {
      setError(loginFetchErrorMessage(err, 'Dev login'))
    } finally {
      setDevLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="pt-10 pb-3 space-y-2">
          <CardTitle className="text-center">
            <div className="flex justify-center">
              <TrimProLoginBadge />
            </div>
          </CardTitle>
          <CardDescription className="text-center">
            Sign in to your account
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              style={{ backgroundColor: 'var(--brand-button-color)', color: 'var(--brand-button-text-color)' }}
              disabled={loading || devLoading}
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>
            {showDevLogin && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={loading || devLoading}
                onClick={handleDevLogin}
              >
                {devLoading ? 'Signing in...' : 'Dev Login'}
              </Button>
            )}
            <div className="text-center">
              <a
                href="/auth/forgot-password"
                className="text-sm hover:underline"
                style={{ color: 'var(--brand-link-color)' }}
              >
                Forgot password?
              </a>
            </div>
          </form>
          <div className="mt-6 border-t pt-4 text-center text-xs text-muted-foreground">
            <span>By signing in, you agree to our </span>
            <Link href="/terms" className="hover:underline" style={{ color: 'var(--brand-link-color)' }}>
              Terms
            </Link>
            <span> and </span>
            <Link href="/privacy" className="hover:underline" style={{ color: 'var(--brand-link-color)' }}>
              Privacy Policy
            </Link>
            <span>.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
