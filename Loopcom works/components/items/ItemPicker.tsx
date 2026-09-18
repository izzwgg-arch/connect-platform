'use client'

import { useState, useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Package, X } from 'lucide-react'

interface Item {
  id: string
  name: string
  sku: string | null
  type: string
  kind: string
  description: string | null
  unit: string
  defaultUnitPrice: number
  taxable: boolean
  taxRate: number | null
}

interface ItemPickerProps {
  onSelect: (item: Item) => void
  onClose: () => void
}

export function ItemPicker({ onSelect, onClose }: ItemPickerProps) {
  const [items, setItems] = useState<Item[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    fetchItems()
  }, [])

  const fetchItems = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/items?active=true&limit=100&search=${encodeURIComponent(search)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = await response.json()
        setItems(data.items || [])
      }
    } catch (error) {
      console.error('Error fetching items:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (search !== '') {
        fetchItems()
      } else {
        fetchItems()
      }
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [search])

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold">Select Item</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 border-b">
          <Input
            ref={inputRef}
            placeholder="Search items by name or SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading items...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Package className="mx-auto h-12 w-12 text-gray-400 mb-2" />
              <p>No items found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelect(item)
                    onClose()
                  }}
                  className="w-full text-left p-3 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <div className="font-medium text-gray-900">{item.name}</div>
                        {item.kind === 'BUNDLE' && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-800">
                            Bundle
                          </span>
                        )}
                      </div>
                      {item.sku && <div className="text-sm text-gray-500">SKU: {item.sku}</div>}
                      {item.description && (
                        <div className="text-sm text-gray-600 mt-1 line-clamp-1">{item.description}</div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-gray-900">${item.defaultUnitPrice.toFixed(2)}</div>
                      <div className="text-sm text-gray-500">{item.unit}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
