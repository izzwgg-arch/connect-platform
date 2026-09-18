'use client'

import { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Package } from 'lucide-react'
import { smartMatch, scoreHaystack } from '@/lib/search/scoring'

interface Item {
  id: string
  name: string
  sku: string | null
  kind: string
  defaultUnitPrice: number
  defaultUnitCost: number | null
  unit: string
}

interface Bundle {
  id: string
  name: string
  item: {
    id: string
    name: string
  }
}

interface RapidFireItemPickerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (item: Item | Bundle, isBundle: boolean) => void
  onNextLine?: () => void // Callback for Left Arrow to move to next line
  items: Item[]
  bundles: Bundle[]
}

export function RapidFireItemPicker({
  isOpen,
  onClose,
  onSelect,
  onNextLine,
  items,
  bundles,
}: RapidFireItemPickerProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Combine items and bundles for unified search
  const allItems = [
    ...items.map((item) => ({ ...item, isBundle: false, displayName: item.name })),
    ...bundles.map((bundle) => ({
      ...bundle,
      name: bundle.name || bundle.item?.name || 'Bundle',
      displayName: bundle.name || bundle.item?.name || 'Bundle',
      isBundle: true,
      id: bundle.id,
      sku: null,
    })),
  ]

  // Filter based on search query
  const filteredItems = (() => {
    const query = searchQuery.trim()
    if (!query) return allItems
    return [...allItems]
      .filter((item) => smartMatch(query, [item.displayName, item.sku]))
      .sort(
        (a, b) =>
          scoreHaystack(query, [b.displayName, b.sku], []) -
          scoreHaystack(query, [a.displayName, a.sku], [])
      )
  })()

  // Auto-focus search input when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus()
      setSearchQuery('')
      setSelectedIndex(0)
    }
  }, [isOpen])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }, [selectedIndex])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filteredItems.length - 1))
        break

      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
        break

      case 'Enter':
      case 'ArrowRight':
        e.preventDefault()
        if (filteredItems[selectedIndex]) {
          const selected = filteredItems[selectedIndex]
          if (selected.isBundle) {
            const bundle = bundles.find((b) => b.id === selected.id)
            if (bundle) {
              onSelect(bundle, true)
            }
          } else {
            const item = items.find((i) => i.id === selected.id)
            if (item) {
              onSelect(item, false)
            }
          }
          setSearchQuery('')
          setSelectedIndex(0)
          onClose()
        }
        break

      case 'ArrowLeft':
        e.preventDefault()
        if (onNextLine) {
          onNextLine()
          onClose()
        }
        break

      case 'Escape':
        e.preventDefault()
        onClose()
        break

      default:
        // Allow typing in search box
        break
    }
  }

  if (!isOpen) return null

  return (
    <div className="w-full bg-white border border-gray-300 rounded-md shadow-lg max-h-80 overflow-hidden">
      <div className="p-2 border-b border-gray-200">
        <Input
          ref={searchInputRef}
          type="text"
          placeholder="Search items or bundles..."
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={handleKeyDown}
          className="w-full"
          autoFocus
        />
      </div>
      <div
        ref={listRef}
        className="overflow-y-auto max-h-64"
        style={{ maxHeight: '16rem' }}
      >
        {filteredItems.length === 0 ? (
          <div className="p-4 text-center text-gray-500 text-sm">
            No items found
          </div>
        ) : (
          filteredItems.map((item, index) => {
            const isSelected = index === selectedIndex
            const isBundle = item.isBundle

            return (
              <div
                key={item.id}
                className={`px-4 py-2 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-blue-100 border-l-2 border-blue-500'
                    : 'hover:bg-gray-50'
                }`}
                onClick={() => {
                  if (isBundle) {
                    const bundle = bundles.find((b) => b.id === item.id)
                    if (bundle) {
                      onSelect(bundle, true)
                    }
                  } else {
                    const itemObj = items.find((i) => i.id === item.id)
                    if (itemObj) {
                      onSelect(itemObj, false)
                    }
                  }
                  setSearchQuery('')
                  setSelectedIndex(0)
                  onClose()
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Package className="h-4 w-4 text-gray-400" />
                    <span className="font-medium">{item.displayName}</span>
                    {isBundle && (
                      <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded">
                        Bundle
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-600">
                    {!isBundle && 'defaultUnitPrice' in item && item.defaultUnitPrice != null && (
                      <span>${Number(item.defaultUnitPrice).toFixed(2)}</span>
                    )}
                  </div>
                </div>
                {item.sku && (
                  <div className="text-xs text-gray-500 mt-1">SKU: {item.sku}</div>
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="p-2 border-t border-gray-200 bg-gray-50 text-xs text-gray-500">
        <div className="flex justify-between">
          <span>↑↓ Navigate</span>
          <span>Enter/→ Select</span>
          <span>← Next Line</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  )
}
