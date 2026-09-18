'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { SearchableClientSelect } from '@/components/ui/searchable-client-select'
import { fetchAllPickerClients, type PickerClient } from '@/lib/clients/fetch-all-picker-clients'

interface ReportFilterBarProps {
  clientId: string
  onClientChange: (clientId: string) => void
  jobSiteAddress: string
  onJobSiteAddressChange: (value: string) => void
  hideSubClients: boolean
  onHideSubClientsChange: (value: boolean) => void
  /** Fires with the full selected client (email included) whenever it resolves, or null when cleared. */
  onClientResolved?: (client: PickerClient | null) => void
}

/** Shared customer / job-site / sub-customer rollup filters, reused across financial reports. */
export function ReportFilterBar({
  clientId,
  onClientChange,
  jobSiteAddress,
  onJobSiteAddressChange,
  hideSubClients,
  onHideSubClientsChange,
  onClientResolved,
}: ReportFilterBarProps) {
  const [clients, setClients] = useState<PickerClient[]>([])

  useEffect(() => {
    fetchAllPickerClients()
      .then(setClients)
      .catch(() => setClients([]))
  }, [])

  useEffect(() => {
    if (!onClientResolved) return
    onClientResolved(clientId ? clients.find((c) => c.id === clientId) || null : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clients])

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div>
        <Label>Customer</Label>
        <div className="flex items-center gap-1">
          <div className="flex-1">
            <SearchableClientSelect clients={clients} value={clientId} onSelect={onClientChange} placeholder="All customers" />
          </div>
          {clientId && (
            <Button type="button" variant="ghost" size="sm" title="Clear customer filter" onClick={() => onClientChange('')}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <div>
        <Label>Job Site Address</Label>
        <Input
          value={jobSiteAddress}
          onChange={(e) => onJobSiteAddressChange(e.target.value)}
          placeholder="Street, city, state, or zip"
        />
      </div>
      <div className="flex items-center gap-2 pt-6">
        <Checkbox
          id="hideSubClients"
          checked={hideSubClients}
          onCheckedChange={(v) => onHideSubClientsChange(v === true)}
        />
        <Label htmlFor="hideSubClients" className="!mb-0 cursor-pointer font-normal">
          Roll up sub-customers into parent
        </Label>
      </div>
    </div>
  )
}
