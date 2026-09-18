import type { Metadata } from 'next'
import { Download, Smartphone, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'Download TrimPro Field App',
  description: 'Download the TrimPro Field Android app (APK) for field technicians.',
}

const APK_PATH = '/downloads/trimpro-field.apk'
const APP_VERSION = '1.0.18'

export default function DownloadAppPage() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-[#2E4A59]">android app</p>
        <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">Download TrimPro Field</h1>
        <p className="max-w-2xl text-gray-700">
          Install the TrimPro Field app on your Android phone to manage jobs, requests, time tracking,
          and field updates on the go.
        </p>
      </div>

      <Card className="overflow-hidden border-[#2E4A59]/20 shadow-sm">
        <CardHeader className="bg-[#2E4A59] text-white">
          <CardTitle className="flex items-center gap-3 text-white">
            <Smartphone className="h-6 w-6" />
            TrimPro Field for Android
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-lg font-semibold text-gray-900">Latest APK</p>
              <p className="text-sm text-gray-600">Version {APP_VERSION} - Direct install file</p>
            </div>
            <a
              href={APK_PATH}
              download
              className="inline-flex items-center justify-center rounded-md bg-[#2E4A59] px-5 py-3 text-sm font-semibold text-white hover:bg-[#243b47]"
            >
              <Download className="mr-2 h-5 w-5" />
              Download APK
            </a>
          </div>

          <div className="rounded-lg border bg-gray-50 p-4 text-sm text-gray-700">
            <p className="mb-2 font-semibold text-gray-900">Install steps</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Tap <strong>Download APK</strong> on your Android phone.</li>
              <li>Open the downloaded file when prompted.</li>
              <li>If Android asks, allow installs from this browser/source.</li>
              <li>Tap Install, then open TrimPro Field and sign in.</li>
            </ol>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-5 w-5 text-[#2E4A59]" />
              Safe install tips
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-gray-700">
            <p>Only download from this TrimPro page.</p>
            <p>Use your company login after install.</p>
            <p>Update from this same page when a new APK is published.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-5 w-5 text-[#2E4A59]" />
              What is included
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-gray-700">
            <p>Jobs and requests with full detail views</p>
            <p>Time tracking, media uploads, and messaging</p>
            <p>Role-based mobile permissions set by your admin</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
