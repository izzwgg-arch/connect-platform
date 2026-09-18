'use client'

import { ChevronDown, ChevronRight, LayoutPanelLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import {
  PERMISSION_PAGE_MODULES,
  getModuleActionPermissions,
  getAllModulePermissionKeys,
  isModulePageAccessEnabled,
  isModuleViewAllEnabled,
  type PermissionPageModule,
} from '@/lib/permissions-page-modules'

interface RolePermissionModulePickerProps {
  selectedPermissions: string[]
  onChange: (permissions: string[]) => void
}

export function RolePermissionModulePicker({
  selectedPermissions,
  onChange,
}: RolePermissionModulePickerProps) {
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({})

  const setSelected = (next: string[]) => {
    onChange(Array.from(new Set(next)))
  }

  const togglePermission = (key: string, enabled: boolean) => {
    if (enabled) {
      setSelected([...selectedPermissions, key])
      return
    }
    setSelected(selectedPermissions.filter((p) => p !== key))
  }

  const togglePageAccess = (module: PermissionPageModule, enabled: boolean) => {
    if (enabled) {
      const keys =
        module.id === 'payment-history'
          ? [module.pageAccessPermission, module.viewPermission]
          : [module.pageAccessPermission]
      setSelected([...selectedPermissions, ...keys])
      setExpandedModules((prev) => ({ ...prev, [module.id]: true }))
      return
    }

    const moduleKeys = getAllModulePermissionKeys(module)
    setSelected(selectedPermissions.filter((p) => !moduleKeys.includes(p)))
  }

  const toggleViewAll = (module: PermissionPageModule, enabled: boolean) => {
    if (enabled) {
      setSelected([
        ...selectedPermissions,
        module.pageAccessPermission,
        module.viewPermission,
      ])
      setExpandedModules((prev) => ({ ...prev, [module.id]: true }))
      return
    }
    setSelected(selectedPermissions.filter((p) => p !== module.viewPermission))
  }

  const toggleModuleExpanded = (moduleId: string) => {
    setExpandedModules((prev) => ({ ...prev, [moduleId]: !prev[moduleId] }))
  }

  const selectAllInModule = (module: PermissionPageModule) => {
    const moduleKeys = getAllModulePermissionKeys(module)
    const allSelected = moduleKeys.every((key) => selectedPermissions.includes(key))
    if (allSelected) {
      setSelected(selectedPermissions.filter((key) => !moduleKeys.includes(key)))
      return
    }
    setSelected([...selectedPermissions, ...moduleKeys])
    setExpandedModules((prev) => ({ ...prev, [module.id]: true }))
  }

  const enabledModuleCount = useMemo(
    () =>
      PERMISSION_PAGE_MODULES.filter((module) =>
        getAllModulePermissionKeys(module).some((key) => selectedPermissions.includes(key))
      ).length,
    [selectedPermissions]
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
        <div className="flex items-center gap-2">
          <LayoutPanelLeft className="h-4 w-4 shrink-0" />
          <span>
            Page-based permissions preview — {enabledModuleCount} of {PERMISSION_PAGE_MODULES.length}{' '}
            pages configured
          </span>
        </div>
        <span className="text-xs font-medium uppercase tracking-wide text-blue-700">Dev preview</span>
      </div>

      <div className="max-h-[28rem] space-y-2 overflow-y-auto rounded-md border p-3">
        {PERMISSION_PAGE_MODULES.map((module) => {
          const pageAccessOn = isModulePageAccessEnabled(module, selectedPermissions)
          const viewAllOn = isModuleViewAllEnabled(module, selectedPermissions)
          const actionPermissions = getModuleActionPermissions(module)
          const moduleKeys = getAllModulePermissionKeys(module)
          const anyModulePermission = moduleKeys.some((key) => selectedPermissions.includes(key))
          const expanded = expandedModules[module.id] ?? anyModulePermission
          const createOnlyMode =
            pageAccessOn && !viewAllOn && actionPermissions.some((perm) => selectedPermissions.includes(perm.key))

          return (
            <div
              key={module.id}
              className={cn(
                'rounded-lg border transition-colors',
                anyModulePermission ? 'border-gray-300 bg-white' : 'border-gray-200 bg-gray-50/80'
              )}
            >
              <div className="flex items-start gap-3 p-3">
                <button
                  type="button"
                  onClick={() => toggleModuleExpanded(module.id)}
                  className="mt-0.5 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                  aria-label={expanded ? 'Collapse page permissions' : 'Expand page permissions'}
                >
                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                <div className="flex-1 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-gray-900">{module.label}</p>
                      <p className="text-xs text-gray-500">
                        Access: {module.pageAccessPermission} · View all: {module.viewPermission}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="text-xs font-medium text-gray-600 hover:text-gray-900"
                      onClick={() => selectAllInModule(module)}
                    >
                      {moduleKeys.every((key) => selectedPermissions.includes(key))
                        ? 'Clear page'
                        : 'Select all on page'}
                    </button>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-dashed border-gray-300 bg-gray-50 px-3 py-2 hover:bg-gray-100">
                      <Checkbox
                        className="mt-0.5"
                        checked={pageAccessOn}
                        onCheckedChange={(checked) => togglePageAccess(module, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-800">Access page</span>
                        <span className="block text-xs text-gray-500">
                          Show in sidebar and open this page
                        </span>
                      </span>
                    </label>

                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2',
                        pageAccessOn
                          ? 'border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100'
                          : 'cursor-not-allowed border-gray-200 bg-gray-100 opacity-60'
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={viewAllOn}
                        disabled={!pageAccessOn}
                        onCheckedChange={(checked) => toggleViewAll(module, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-800">View all documents</span>
                        <span className="block text-xs text-gray-500">
                          Browse the full list on this page
                        </span>
                      </span>
                    </label>
                  </div>

                  {createOnlyMode && (
                    <p className="rounded-md bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
                      Create-only mode: user can open this page and use enabled actions, but will not
                      see existing documents in the list.
                    </p>
                  )}
                </div>
              </div>

              {expanded && (
                <div className="space-y-3 border-t bg-white px-3 pb-3 pt-2">
                  {module.subPages && module.subPages.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Sub-pages
                      </p>
                      {module.subPages.map((subPage) => (
                        <label
                          key={subPage.permissionKey}
                          className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 p-2 hover:bg-gray-50"
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={selectedPermissions.includes(subPage.permissionKey)}
                            onCheckedChange={(checked) =>
                              togglePermission(subPage.permissionKey, checked === true)
                            }
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-gray-900">
                              {subPage.label}
                            </span>
                            {subPage.description && (
                              <span className="block text-xs text-gray-500">{subPage.description}</span>
                            )}
                            <span className="mt-0.5 block font-mono text-[10px] text-gray-400">
                              {subPage.permissionKey}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}

                  {actionPermissions.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Actions on this page
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {actionPermissions.map((perm) => (
                          <label
                            key={perm.key}
                            className={cn(
                              'flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 p-2 hover:bg-gray-50',
                              !pageAccessOn && 'cursor-not-allowed opacity-60'
                            )}
                          >
                            <Checkbox
                              className="mt-0.5"
                              checked={selectedPermissions.includes(perm.key)}
                              disabled={!pageAccessOn}
                              onCheckedChange={(checked) =>
                                togglePermission(perm.key, checked === true)
                              }
                            />
                            <span className="min-w-0">
                              <span className="block text-sm text-gray-900">{perm.label}</span>
                              {perm.description && (
                                <span className="block text-xs text-gray-500">{perm.description}</span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {!pageAccessOn && anyModulePermission && (
                    <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                      Actions are enabled but page access is off. Turn on Access page to use them.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
