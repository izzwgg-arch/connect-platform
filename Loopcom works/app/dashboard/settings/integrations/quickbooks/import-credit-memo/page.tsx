'use client'
import { EntityBackButton } from '@/components/navigation/EntityBackButton'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CheckCircle, DownloadCloud, ExternalLink, Loader2, XCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { refreshAccessToken } from '@/lib/auth/client'
import { formatCurrency } from '@/lib/utils'

type ImportResponse =
  | {
      success: true
      alreadyImported: false
      creditMemo: {
        id: string
        creditMemoNumber: string
        title: string
        status: string
        total: number
        remainingCredit: number
        lineItemCount: number
        client: { id: string; name: string; companyName: string | null } | null
      }
      placeholderClientCreated?: boolean
      placeholderClient?: { id: string; name: string } | null
    }
  | {
      success: false
      alreadyImported?: boolean
      error: string
      creditMemo?: {
        id: string
        creditMemoNumber: string
        title: string
        status: string
        total: number
        remainingCredit: number
        lineItemCount: number
        client: { id: string; name: string; companyName: string | null } | null
      }
    }

export default function QuickBooksCreditMemoImportPage() {
  const router = useRouter()
  const [qboCreditMemoId, setQboCreditMemoId] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResponse | null>(null)

  const submitImport = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedId = qboCreditMemoId.trim()
    if (!trimmedId) {
      setResult({
        success: false,
        error: 'Enter a QuickBooks credit memo ID first.',
      })
      return
    }

    setImporting(true)
    setResult(null)

    try {
      let token = localStorage.getItem('accessToken')
      if (!token) {
        const refreshed = await refreshAccessToken()
        if (!refreshed) {
          router.push('/auth/login')
          return
        }
        token = localStorage.getItem('accessToken')
      }

      let response = await fetch('/api/qbo/import-credit-memo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ qboCreditMemoId: trimmedId }),
      })

      if (response.status === 401) {
        const refreshed = await refreshAccessToken()
        if (!refreshed) {
          router.push('/auth/login')
          return
        }
        token = localStorage.getItem('accessToken')
        response = await fetch('/api/qbo/import-credit-memo', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ qboCreditMemoId: trimmedId }),
        })
      }

      const data = (await response.json().catch(() => ({}))) as ImportResponse
      if (!response.ok) {
        setResult({
          success: false,
          alreadyImported: Boolean((data as any)?.alreadyImported),
          error: (data as any)?.error || 'Credit memo import failed.',
          creditMemo: (data as any)?.creditMemo,
        })
        return
      }

      setResult(data)
    } catch (error) {
      console.error('QuickBooks credit memo import failed:', error)
      setResult({
        success: false,
        error: 'Credit memo import failed. Please try again.',
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <EntityBackButton fallbackHref="/dashboard/settings/integrations/quickbooks" />
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Import QuickBooks Credit Memo by ID</h1>
          <p className="mt-1 text-gray-600">
            Manual, one-off import for a single QuickBooks credit memo. Nothing runs until you click Import.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>QuickBooks Credit Memo Import</CardTitle>
          <CardDescription>
            Enter one QuickBooks credit memo ID to import that credit memo only. This page does not poll and does not run any background sync.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitImport} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="qboCreditMemoId">QuickBooks Credit Memo ID</Label>
              <Input
                id="qboCreditMemoId"
                value={qboCreditMemoId}
                onChange={(event) => setQboCreditMemoId(event.target.value)}
                placeholder="Example: 1482"
                inputMode="numeric"
                autoComplete="off"
                disabled={importing}
              />
              <p className="text-xs text-gray-500">
                To find the ID: in QuickBooks go to <strong>Sales → Credit Memos</strong>, open the credit memo, and copy the number from the URL — e.g.{' '}
                <code>
                  …/app/creditmemo?txnId=<strong>1234</strong>
                </code>{' '}
                → enter <strong>1234</strong>.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                If that credit memo is already in Trim Pro, the import is blocked instead of creating a duplicate.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={importing}>
                {importing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <DownloadCloud className="mr-2 h-4 w-4" />
                    Import Credit Memo
                  </>
                )}
              </Button>
              <Link href="/dashboard/settings/integrations/quickbooks">
                <Button type="button" variant="outline" disabled={importing}>
                  Back to QuickBooks
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card className={result.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}>
          <CardHeader>
            <div className="flex items-start gap-3">
              {result.success ? (
                <CheckCircle className="mt-0.5 h-5 w-5 text-green-600" />
              ) : (
                <XCircle className="mt-0.5 h-5 w-5 text-red-600" />
              )}
              <div>
                <CardTitle className={result.success ? 'text-green-900' : 'text-red-900'}>
                  {result.success
                    ? 'Credit memo imported successfully'
                    : result.alreadyImported
                      ? 'Credit memo already imported'
                      : 'Import failed'}
                </CardTitle>
                <CardDescription className={result.success ? 'text-green-700' : 'text-red-700'}>
                  {result.success
                    ? 'The requested QuickBooks credit memo was imported into Trim Pro.'
                    : result.error}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {result.creditMemo && (
              <div className="rounded border bg-white p-4 text-gray-700">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-semibold">{result.creditMemo.creditMemoNumber}</span>
                  <span>{result.creditMemo.title}</span>
                  <span>Status: {result.creditMemo.status}</span>
                  <span>Total: {formatCurrency(Number(result.creditMemo.total || 0))}</span>
                  <span>
                    Remaining: {formatCurrency(Number(result.creditMemo.remainingCredit || 0))}
                  </span>
                  <span>Lines: {result.creditMemo.lineItemCount}</span>
                </div>
                <div className="mt-2 text-xs text-gray-500">
                  Client: {result.creditMemo.client?.name || 'No linked client'}
                  {result.creditMemo.client?.companyName
                    ? ` • ${result.creditMemo.client.companyName}`
                    : ''}
                </div>
                <div className="mt-3">
                  <Link href={`/dashboard/credit-memos/${result.creditMemo.id}`}>
                    <Button variant="outline" size="sm">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open Credit Memo
                    </Button>
                  </Link>
                </div>
              </div>
            )}

            {result.success && result.placeholderClientCreated ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-800">
                The QuickBooks customer was not mapped locally, so Trim Pro created a placeholder client to keep this import manual and one-off. No broad customer sync was run.
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
