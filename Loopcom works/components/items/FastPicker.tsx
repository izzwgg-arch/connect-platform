'use client'

import { useState, useEffect, useLayoutEffect, useRef, useCallback, KeyboardEvent, useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { Package } from 'lucide-react'
import { scrollPickerRowIntoComfortZone } from '@/lib/ui/scroll-picker-row'
import { smartMatch, scoreHaystack } from '@/lib/search/scoring'

export interface FastPickerItem {
  id: string
  name: string
  sku: string | null
  kind: 'SINGLE' | 'BUNDLE'
  defaultUnitPrice: number
  defaultUnitCost: number | null
  // When PERCENT_OF_ABOVE, this item's price is computed from the lines
  // already above it rather than using defaultUnitPrice — see percentOfAboveRate.
  pricingMode?: 'FIXED' | 'PERCENT_OF_ABOVE'
  percentOfAboveRate?: number | null
  unit: string
  vendorId: string | null
  vendorName: string | null
  taxable: boolean
  taxRate: number | null
  // Item master "Description" (ex: QBO SalesDesc/PurchaseDesc). Used to prefill
  // line-item description/notes fields on estimates/invoices/POs.
  description?: string | null
  notes: string | null
  // For bundles
  bundleId?: string
  // Tag(s) for display — shown in picker only when showTagColumn is true (e.g. purchase orders)
  tag?: string | null
}

interface FastPickerProps {
  value: string
  onChange: (value: string) => void
  onSelect: (item: FastPickerItem) => void
  onNextLine?: () => void // Called after Enter to move to next line
  items: FastPickerItem[]
  bundles: FastPickerItem[]
  placeholder?: string
  disabled?: boolean
  className?: string
  inputRef?: (el: HTMLInputElement | null) => void // Callback to expose input ref
  /** When true, show a "Tag" column in the dropdown (e.g. for purchase orders) */
  showTagColumn?: boolean
}

const ITEM_HEIGHT = 48 // Height of each item in pixels
const VISIBLE_ITEMS = 8 // Number of items visible without scrolling

export function FastPicker({
  value,
  onChange,
  onSelect,
  onNextLine,
  items = [],
  bundles = [],
  placeholder = 'Type to search items...',
  disabled = false,
  className = '',
  inputRef: inputRefCallback,
  showTagColumn = false,
}: FastPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filteredItems, setFilteredItems] = useState<FastPickerItem[]>([])
  const [remoteItems, setRemoteItems] = useState<FastPickerItem[]>([])
  const [remoteBundles, setRemoteBundles] = useState<FastPickerItem[]>([])
  
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const isSelectingRef = useRef(false) // Prevent race conditions
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Expose input ref to parent
  useEffect(() => {
    if (inputRefCallback && inputRef.current) {
      inputRefCallback(inputRef.current)
    }
    return () => {
      if (inputRefCallback) {
        inputRefCallback(null)
      }
    }
  }, [inputRefCallback])

  // Live-sync picker data from API so new items appear immediately
  useEffect(() => {
    if (!isOpen) return

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }

    searchDebounceRef.current = setTimeout(async () => {
      try {
        const token = localStorage.getItem('accessToken')
        if (!token) return

        const query = searchQuery.trim()
        const url = `/api/items/picker${query ? `?search=${encodeURIComponent(query)}` : ''}`
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) return
        const data = await response.json()
        setRemoteItems(Array.isArray(data.items) ? data.items : [])
        setRemoteBundles(Array.isArray(data.bundles) ? data.bundles : [])
      } catch (error) {
        console.error('FastPicker live sync failed:', error)
      }
    }, 180)

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }
    }
  }, [isOpen, searchQuery])

  // Prefer fresh server data while picker is open; fallback to props.
  const sourceItems =
    isOpen && (remoteItems.length > 0 || remoteBundles.length > 0) ? remoteItems : items
  const sourceBundles =
    isOpen && (remoteItems.length > 0 || remoteBundles.length > 0) ? remoteBundles : bundles

  // Combine items and bundles from current source (stable, render-driven source of truth)
  const allItems = useMemo(
    () => [
      ...sourceItems.map(item => ({ ...item, kind: 'SINGLE' as const })),
      ...sourceBundles.map(bundle => ({ ...bundle, kind: 'BUNDLE' as const })),
    ],
    [sourceItems, sourceBundles]
  )

  // Query-driven filtering: only recalculates when query/items change,
  // not on every arrow key navigation re-render.
  const filteredByQuery = useMemo(() => {
    const query = searchQuery.trim()
    if (!query) {
      return allItems
    }

    return [...allItems]
      .filter((item) =>
        smartMatch(query, [item.name, item.sku, item.description, item.notes, item.vendorName, item.tag])
      )
      .sort(
        (a, b) =>
          scoreHaystack(query, [b.name, b.sku], [b.description, b.vendorName]) -
          scoreHaystack(query, [a.name, a.sku], [a.description, a.vendorName])
      )
  }, [searchQuery, allItems])

  useEffect(() => {
    setFilteredItems(filteredByQuery)
    setSelectedIndex(0)
  }, [filteredByQuery])

  // Keep highlighted row in a comfortable viewport (not flush to top/bottom edges)
  useLayoutEffect(() => {
    if (!isOpen || !listRef.current || selectedIndex < 0) return
    const selectedElement = itemRefs.current[selectedIndex]
    if (!selectedElement) return
    scrollPickerRowIntoComfortZone(selectedElement, listRef.current, { edgeMarginPx: 20 })
  }, [selectedIndex, isOpen, filteredItems.length, showTagColumn])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSearchQuery('')
        setSelectedIndex(0)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [isOpen])

  const handleSelect = useCallback((item: FastPickerItem) => {
    if (isSelectingRef.current) return // Prevent duplicate selections
    isSelectingRef.current = true
    console.log('SELECTED ITEM:', item)

    // Close dropdown first to prevent any visual glitches
    setIsOpen(false)
    setSearchQuery('')
    setSelectedIndex(0)

    // Call onSelect to populate all line item data (including description)
    // onSelect will update the entire line item atomically, including description
    // The input value will update automatically via the controlled value prop
    const selectResult = onSelect(item)
    
    // Auto-advance to next line after ensuring state updates complete
    if (onNextLine) {
      // If onSelect returns a promise, wait for it
      if (selectResult && typeof selectResult.then === 'function') {
        selectResult.then(() => {
          // Wait for React to process all state updates and re-render
          requestAnimationFrame(() => {
            setTimeout(() => {
              onNextLine()
              isSelectingRef.current = false
            }, 50)
          })
        }).catch((err) => {
          console.error('Error in onSelect:', err)
          // Even if there's an error, still move to next line after a delay
          requestAnimationFrame(() => {
            setTimeout(() => {
              onNextLine()
              isSelectingRef.current = false
            }, 50)
          })
        })
      } else {
        // onSelect is synchronous, use requestAnimationFrame to ensure React state updates
        requestAnimationFrame(() => {
          setTimeout(() => {
            onNextLine()
            isSelectingRef.current = false
          }, 100)
        })
      }
    } else {
      isSelectingRef.current = false
    }
  }, [onSelect, onNextLine])

  // Handle committing current text as custom entry (no item selected)
  const handleCommitCustom = useCallback(() => {
    if (isSelectingRef.current) return
    isSelectingRef.current = true

    // Get the current input value
    const currentValue = inputRef.current?.value || value
    
    // Ensure the current value is committed via onChange
    if (currentValue.trim()) {
      onChange(currentValue.trim())
    }

    // Close dropdown
    setIsOpen(false)
    setSearchQuery('')
    setSelectedIndex(0)
    
    // Auto-advance to next line after ensuring state is committed
    if (onNextLine) {
      // Use requestAnimationFrame to ensure React has processed the onChange state update
      requestAnimationFrame(() => {
        setTimeout(() => {
          onNextLine()
          isSelectingRef.current = false
        }, 50)
      })
    } else {
      isSelectingRef.current = false
    }
  }, [onNextLine, onChange, value])

  const commitHighlightedSelection = useCallback(() => {
    if (filteredItems.length === 0) {
      handleCommitCustom()
      return
    }

    const clampedIndex = Math.max(0, Math.min(selectedIndex, filteredItems.length - 1))
    const selected = filteredItems[clampedIndex]
    if (!selected) {
      handleCommitCustom()
      return
    }

    handleSelect(selected)
  }, [filteredItems, selectedIndex, handleSelect, handleCommitCustom])

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        if (!isOpen) {
          setIsOpen(true)
          setSelectedIndex(0)
        } else {
          setSelectedIndex(prev => 
            prev < filteredItems.length - 1 ? prev + 1 : prev
          )
        }
        break

      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        if (isOpen) {
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : 0))
        }
        break

      case 'Enter':
        if (e.shiftKey) {
          // Shift+Enter inside the item picker: do nothing. The item picker is
          // a single-line autocomplete; multi-line input lives in the
          // separate "Description (optional)" textarea below.
          e.preventDefault()
          e.stopPropagation()
          break
        }
        e.preventDefault()
        e.stopPropagation()
        if (isOpen) {
          commitHighlightedSelection()
        } else {
          // Dropdown is closed: commit current text instead of moving focus away.
          handleCommitCustom()
        }
        break

      case 'ArrowRight':
        e.preventDefault()
        e.stopPropagation()
        if (isOpen) {
          commitHighlightedSelection()
        } else {
          handleCommitCustom()
        }
        break

      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        setIsOpen(false)
        setSearchQuery('')
        setSelectedIndex(0)
        inputRef.current?.blur()
        break

      case 'Tab':
        // Allow tab to close and move to next field
        if (isOpen) {
          setIsOpen(false)
          setSearchQuery('')
          setSelectedIndex(0)
        }
        break

      default:
        // Any other key opens the picker if it's closed
        if (!isOpen && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          setIsOpen(true)
        }
        break
    }
  }, [isOpen, filteredItems.length, selectedIndex, disabled, handleCommitCustom, commitHighlightedSelection])

  // Handle input focus - opens dropdown immediately
  const handleInputFocus = useCallback(() => {
    if (!disabled && !isOpen) {
      setIsOpen(true)
    }
  }, [disabled, isOpen])

  // Handle input click - ensures dropdown opens
  const handleInputClick = useCallback(() => {
    if (!disabled && !isOpen) {
      setIsOpen(true)
    }
  }, [disabled, isOpen])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    onChange(newValue)
    setSearchQuery(newValue)
    if (!isOpen) {
      setIsOpen(true)
    }
  }, [onChange, isOpen])

  // Handle item click
  const handleItemClick = useCallback((item: FastPickerItem) => {
    handleSelect(item)
  }, [handleSelect])

  return (
    <div ref={containerRef} className="relative w-full">
      <Input
        ref={inputRef}
        value={value}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onClick={handleInputClick}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        autoComplete="off"
        data-picker-input="true"
      />
      
      {/* Dropdown */}
      {isOpen && filteredItems.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-[100] w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-[400px] overflow-y-auto mt-1"
          style={{ maxHeight: `${VISIBLE_ITEMS * ITEM_HEIGHT}px` }}
        >
          {showTagColumn && (
            <div className="grid grid-cols-[1fr_120px_64px] gap-2 px-4 py-2 text-xs font-semibold text-gray-500 border-b bg-gray-50">
              <span>Item</span>
              <span className="text-right">Tag</span>
              <span className="text-right">Price</span>
            </div>
          )}
          {filteredItems.map((item, index) => {
            const isSelected = index === selectedIndex
            const isBundle = item.kind === 'BUNDLE'

            return (
              <div
                key={`${item.kind}-${item.id}`}
                ref={(el) => {
                  itemRefs.current[index] = el
                }}
                className={`px-4 py-3 cursor-pointer transition-colors touch-manipulation min-h-[48px] flex items-center ${
                  isSelected
                    ? 'bg-blue-100 border-l-2 border-blue-500'
                    : 'active:bg-gray-100 sm:hover:bg-gray-50'
                }`}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleItemClick(item)
                }}
              >
                {showTagColumn ? (
                  <div className="grid grid-cols-[1fr_120px_64px] gap-2 items-center">
                    <div className="flex items-center space-x-2 min-w-0">
                      <Package className="h-4 w-4 text-gray-400 flex-shrink-0" />
                      <span className="font-medium truncate">{item.name}</span>
                      {isBundle && (
                        <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded flex-shrink-0">
                          Bundle
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500 truncate text-right" title={item.tag || undefined}>
                      {item.tag != null && item.tag !== '' ? item.tag : '—'}
                    </span>
                    <span className="text-sm text-gray-600 text-right">
                      {isBundle
                        ? '—'
                        : item.pricingMode === 'PERCENT_OF_ABOVE'
                          ? `${Number(item.percentOfAboveRate || 0)}% of above`
                          : item.defaultUnitPrice != null
                            ? `$${Number(item.defaultUnitPrice).toFixed(2)}`
                            : '—'}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 flex-1 min-w-0">
                      <Package className="h-4 w-4 text-gray-400 flex-shrink-0" />
                      <span className="font-medium truncate">{item.name}</span>
                      {isBundle && (
                        <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded flex-shrink-0">
                          Bundle
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-600 flex-shrink-0 ml-2">
                      {!isBundle && item.pricingMode === 'PERCENT_OF_ABOVE' ? (
                        <span>{Number(item.percentOfAboveRate || 0)}% of above</span>
                      ) : (
                        !isBundle && item.defaultUnitPrice != null && (
                          <span>${Number(item.defaultUnitPrice).toFixed(2)}</span>
                        )
                      )}
                    </div>
                  </div>
                )}
                {item.description && item.description.trim() && (
                  <div className="text-xs text-gray-500 mt-1 ml-6 line-clamp-1">
                    {item.description}
                  </div>
                )}
                {item.sku && (
                  <div className="text-xs text-gray-500 mt-1 ml-6">
                    SKU: {item.sku}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      
      {/* No items found */}
      {isOpen && filteredItems.length === 0 && (
        <div className="absolute z-[100] w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1">
          <div className="px-4 py-8 text-center text-gray-500">
            No items found
          </div>
        </div>
      )}
    </div>
  )
}
