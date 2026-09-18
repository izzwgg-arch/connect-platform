'use client'

import { Button } from '@/components/ui/button'

export function PaginationControls(props: {
  page: number
  totalPages: number
  total?: number
  onPrev: () => void
  onNext: () => void
  disabled?: boolean
  className?: string
}) {
  const { page, totalPages, total, onPrev, onNext, disabled, className } = props
  if (!totalPages || totalPages <= 1) return null

  return (
    <div className={`flex items-center justify-between pt-2 ${className || ''}`}>
      <div className="text-sm text-gray-600">
        Page {page} of {totalPages}
        {typeof total === 'number' ? ` · ${total} total` : ''}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onPrev} disabled={disabled || page <= 1}>
          Prev
        </Button>
        <Button variant="outline" onClick={onNext} disabled={disabled || page >= totalPages}>
          Next
        </Button>
      </div>
    </div>
  )
}

