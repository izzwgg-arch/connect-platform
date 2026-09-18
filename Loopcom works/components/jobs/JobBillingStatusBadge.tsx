import {
  formatJobBillingStatus,
  jobBillingStatusColorClass,
} from '@/lib/jobs/billing-status'

export function JobBillingStatusBadge({
  status,
  className = '',
}: {
  status?: string | null
  className?: string
}) {
  const label = formatJobBillingStatus(status)
  return (
    <span
      className={`inline-flex px-2 py-1 text-xs rounded-full font-medium ${jobBillingStatusColorClass(
        status
      )} ${className}`}
    >
      {label}
    </span>
  )
}
