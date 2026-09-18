'use client'

import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Users, TrendingUp, Briefcase, Truck, Clock, CreditCard } from 'lucide-react'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'

const FINANCIAL_REPORTS = [
  {
    href: '/dashboard/reports/revenue',
    name: 'Revenue by Month',
    description: 'Invoiced vs. collected revenue, compared to the prior period',
    icon: TrendingUp,
    permission: 'reports.view',
  },
  {
    href: '/dashboard/reports/aging',
    name: 'Invoices Aging',
    description: 'Outstanding balances by how overdue they are',
    icon: Clock,
    permission: 'reports.view',
  },
  {
    href: '/dashboard/reports/customer-statement',
    name: 'Customer Statement',
    description: 'Invoices, payments applied, and running balance for a customer',
    icon: Users,
    permission: 'reports.view',
  },
  {
    href: '/dashboard/reports/job-profitability',
    name: 'Job Profitability',
    description: 'Revenue vs. labor and material cost per job',
    icon: Briefcase,
    permission: 'reports.view',
  },
  {
    href: '/dashboard/reports/vendor-spend',
    name: 'Vendor Spend',
    description: 'Purchase order spend by vendor',
    icon: Truck,
    permission: 'reports.view',
  },
  {
    href: '/dashboard/reports/payments',
    name: 'Payment History',
    description: 'SOLA + QuickBooks ACH payment events and refunds',
    icon: CreditCard,
    permission: 'payments.view',
  },
] as const

export default function ReportsPage() {
  const { permissions, loading: permissionsLoading } = usePermissions()

  const visibleReports = FINANCIAL_REPORTS.filter((report) => hasPermission(permissions, report.permission))

  if (permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading reports...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Reports</h1>
        <p className="text-gray-600 mt-1">Generate and manage reports</p>
      </div>

      {visibleReports.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-600">
            You don't have access to any reports yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Financial Reports</CardTitle>
            <CardDescription>Ready-to-run reports with charts, totals, and PDF/CSV export</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleReports.map((report) => (
                <Link key={report.href} href={report.href}>
                  <Card className="h-full hover:border-blue-500 hover:shadow-sm transition-all cursor-pointer">
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <report.icon className="h-5 w-5 text-blue-600" />
                        {report.name}
                      </CardTitle>
                      <CardDescription>{report.description}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
