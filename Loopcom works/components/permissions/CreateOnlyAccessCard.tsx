'use client'

import type { LucideIcon } from 'lucide-react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface CreateOnlyAccessCardProps {
  icon: LucideIcon
  entityLabel: string
  createButtonLabel: string
  canCreate: boolean
  onCreate: () => void
}

export function CreateOnlyAccessCard({
  icon: Icon,
  entityLabel,
  createButtonLabel,
  canCreate,
  onCreate,
}: CreateOnlyAccessCardProps) {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <Icon className="mx-auto h-12 w-12 text-gray-400" />
        <h3 className="mt-3 text-sm font-medium text-gray-900">Create-only access</h3>
        <p className="mt-1 text-sm text-gray-500">
          You can create new {entityLabel}, but you do not have permission to browse existing ones.
        </p>
        {canCreate && (
          <div className="mt-6">
            <Button onClick={onCreate}>
              <Plus className="mr-2 h-4 w-4" />
              {createButtonLabel}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
