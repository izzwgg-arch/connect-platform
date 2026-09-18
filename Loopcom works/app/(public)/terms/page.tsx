import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'TrimPro – Terms of Service',
  description:
    'TrimPro Terms of Service / User License Agreement governing use of the TrimPro platform.',
}

const EFFECTIVE_DATE = '2026-02-16'

export default function TermsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-gray-900">Terms of Service / User License Agreement</h1>
        <p className="text-sm text-muted-foreground">Effective date: {EFFECTIVE_DATE}</p>
        <p className="text-gray-700">
          These Terms govern your access to and use of TrimPro (“TrimPro”, “we”, “us”) including the
          web portal and mobile field app (the “Services”). By using the Services, you agree to these Terms.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. SaaS License</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            Subject to these Terms, TrimPro grants you a limited, non-exclusive, non-transferable,
            revocable license to access and use the Services for your internal business purposes.
          </p>
          <p>You may not copy, resell, lease, reverse engineer, or attempt to extract source code except as permitted by law.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Accounts, Roles, and Responsibilities</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <ul className="list-disc pl-5 space-y-1">
            <li>You are responsible for maintaining the confidentiality of your credentials.</li>
            <li>Admins can invite users, assign roles/permissions, and manage data access.</li>
            <li>You must ensure your users use the Services in compliance with these Terms and applicable laws.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Acceptable Use</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Use the Services for unlawful, harmful, or abusive activity.</li>
            <li>Upload malware or attempt to disrupt or overload the Services.</li>
            <li>Access data you are not authorized to access.</li>
            <li>Send spam or unsolicited messages using any messaging features or integrations.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Customer Data Ownership</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            You (the customer/tenant) own your data, including client records, jobs, tasks, issues, schedules,
            and uploaded files (“Customer Data”). We process Customer Data only to provide and improve the Services
            and as instructed through your use of the platform.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>5. Uploaded Content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <ul className="list-disc pl-5 space-y-1">
            <li>You represent you have rights to upload content (photos, videos, documents) to the Services.</li>
            <li>You must not upload content that violates laws or third-party rights.</li>
            <li>We may remove content if required for security, legal compliance, or to prevent abuse.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>6. Integrations (QuickBooks, VoIP/SMS, Messaging)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-gray-700">
          <p className="font-semibold">QuickBooks / Intuit</p>
          <p>
            If you connect QuickBooks via OAuth, you authorize TrimPro to access and sync data to/from Intuit APIs
            based on your configuration (for example: customers, invoices, payments). Intuit is not responsible for
            the Services and does not endorse TrimPro.
          </p>
          <p className="font-semibold">VoIP/SMS/MMS</p>
          <p>
            If enabled, calling and messaging features may rely on third-party carriers/providers. Delivery,
            routing, and availability are not guaranteed, and may be impacted by carrier rules, spam filtering,
            user consent requirements, and network conditions.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>7. Fees and Payment Terms</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            Fees, billing cadence, and payment terms (if applicable) are provided in your order form, subscription
            agreement, or invoice. Non-payment may result in suspension or termination of access.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>8. Warranty Disclaimer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            THE SERVICES ARE PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS,
            IMPLIED, OR STATUTORY, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
            AND NON-INFRINGEMENT.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>9. Limitation of Liability</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, TRIMPRO WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL,
            CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL.
          </p>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, TRIMPRO’S TOTAL LIABILITY FOR ANY CLAIM RELATING TO THE SERVICES
            WILL NOT EXCEED THE AMOUNT YOU PAID TO TRIMPRO FOR THE SERVICES IN THE 3 MONTHS BEFORE THE EVENT GIVING
            RISE TO THE CLAIM.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>10. Termination</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-gray-700">
          <p>
            We may suspend or terminate access if you violate these Terms, if required by law, or for security reasons.
            You may stop using the Services at any time. Upon termination, your right to use the Services ends.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>11. Governing Law</CardTitle>
        </CardHeader>
        <CardContent className="text-gray-700">
          <p>
            These Terms are governed by the laws of the State of New York, USA, without regard to conflict of laws rules.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>12. Contact</CardTitle>
        </CardHeader>
        <CardContent className="text-gray-700">
          <p>
            Questions about these Terms? Contact{' '}
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

