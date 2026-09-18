import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'TrimPro – Privacy Policy',
  description:
    'TrimPro privacy policy describing what data we collect, how we use it, and your rights.',
}

const EFFECTIVE_DATE = '2026-02-16'

export default function PrivacyPolicyPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-gray-900">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">Effective date: {EFFECTIVE_DATE}</p>
        <p className="text-gray-700">
          This Privacy Policy explains how TrimPro (“TrimPro”, “we”, “us”) collects, uses,
          and shares information when you use our web application and mobile field app
          (collectively, the “Services”).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Information We Collect</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-gray-700">
          <p>
            We collect information to operate the Services, provide features, improve reliability,
            and support integrations you enable.
          </p>
          <div className="space-y-2">
            <p className="font-semibold">Account and organization data</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Name, email, phone, role, and authentication information.</li>
              <li>Company/tenant information and user permissions.</li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="font-semibold">Operational data you enter</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Clients/contacts, jobs, schedules, tasks, issues, notes, and related activity history.</li>
              <li>Estimates, invoices, purchase orders, payments, and records linked to your workflow.</li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="font-semibold">Uploaded content</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Photos, videos, and files uploaded and attached to jobs, tasks, issues, and messages.</li>
              <li>Metadata such as file name, size, and upload timestamps.</li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="font-semibold">Usage and log data</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>IP address, device/browser type, pages/screens visited, and error logs.</li>
              <li>Audit logs for key actions (e.g., creating or updating records).</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mobile Permissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-gray-700">
          <p>
            If you use the TrimPro Field mobile app, you may be prompted to grant device permissions.
            You can typically enable/disable these in your device settings.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Camera and Photos/Media: capture and upload job site photos/videos and attachments.</li>
            <li>Microphone: record audio/video or support calling features if enabled.</li>
            <li>Location: optionally share location during active work for dispatch/coordination (if enabled).</li>
            <li>Notifications: receive job/task/issue assignments and message alerts.</li>
            <li>Files/Storage: select and upload documents from device storage.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How We Use Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <ul className="list-disc pl-5 space-y-1">
            <li>Provide and maintain the Services, including job management and dispatch workflows.</li>
            <li>Enable features you use, such as messaging, file uploads, and schedule coordination.</li>
            <li>Process and record financial documents (e.g., invoices) and payment status where applicable.</li>
            <li>Connect integrations you choose (e.g., QuickBooks) and sync data at your direction.</li>
            <li>Prevent fraud/abuse, monitor reliability, and troubleshoot issues.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How We Share Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-gray-700">
          <p>We do not sell your personal information.</p>
          <p className="font-semibold">We may share information with:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Service providers that help run the Services (hosting, storage, monitoring, email delivery).
            </li>
            <li>
              Integrations you enable, such as QuickBooks/Intuit (OAuth), VoIP/SMS providers (e.g., VoIP.ms),
              and messaging providers (e.g., WhatsApp API) if configured by your organization.
            </li>
            <li>Legal or compliance requests if required by law, subpoena, or court order.</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Integrations are optional and controlled by your organization. Data shared depends on what you enable
            and configure.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data Retention</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            We retain data for as long as your account is active and as needed to provide the Services.
            Administrators can manage and delete many records within the app. Backups and logs may persist
            for a limited period for security and reliability.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            We use reasonable administrative, technical, and physical safeguards designed to protect
            information. No method of transmission or storage is 100% secure, and we cannot guarantee
            absolute security.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your Rights and Choices</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <ul className="list-disc pl-5 space-y-1">
            <li>Access: request access to data associated with your account.</li>
            <li>Correction: update certain information in the app or request corrections.</li>
            <li>Deletion: request deletion of your account data, subject to legal/contractual requirements.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contact</CardTitle>
        </CardHeader>
        <CardContent className="text-gray-700">
          <p>
            Questions about this policy? Contact us at{' '}
            <a className="text-[#2E4A59] hover:underline" href="mailto:support@trimprony.com">
              support@trimprony.com
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

