'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Edit, Trash2, Search } from 'lucide-react'
import { smartMatch } from '@/lib/search/scoring'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog'
import { getPermissionsByCategory } from '@/lib/permissions-catalog'
import { RolePermissionModulePicker } from '@/components/settings/RolePermissionModulePicker'
import { usePermissions, hasPermission } from '@/hooks/usePermissions'

interface Role {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  isActive: boolean
  permissions: Array<{ permission: { key: string; label: string } }>
}

export default function RolesPage() {
  const { permissions } = usePermissions()
  const canCreate = hasPermission(permissions, 'roles.create')
  const canEdit = hasPermission(permissions, 'roles.edit')
  const canDelete = hasPermission(permissions, 'roles.delete')
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    permissions: [] as string[],
    mobilePermissions: [] as string[],
  })

  const permissionsByCategory = getPermissionsByCategory()
  
  // Get mobile permissions separately
  const mobilePermissions = permissionsByCategory['Mobile App'] || []

  useEffect(() => {
    fetchRoles()
  }, [])

  const fetchRoles = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/roles', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        window.location.href = '/auth/login'
        return
      }

      if (response.ok) {
        const data = await response.json()
        setRoles(data.roles || [])
      }
    } catch (error) {
      console.error('Error fetching roles:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateRole = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/roles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(formData),
      })

      if (response.ok) {
        setShowCreateModal(false)
        setFormData({ name: '', description: '', permissions: [], mobilePermissions: [] })
        fetchRoles()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to create role')
      }
    } catch (error) {
      console.error('Error creating role:', error)
      alert('Failed to create role')
    }
  }

  const handleUpdateRole = async () => {
    if (!editingRole) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/roles/${editingRole.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(formData),
      })

      if (response.ok) {
        setEditingRole(null)
        setFormData({ name: '', description: '', permissions: [], mobilePermissions: [] })
        fetchRoles()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to update role')
      }
    } catch (error) {
      console.error('Error updating role:', error)
      alert('Failed to update role')
    }
  }

  const handleDeleteRole = async (roleId: string) => {
    if (!confirm('Are you sure you want to delete this role?')) return

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/roles/${roleId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.ok) {
        fetchRoles()
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to delete role')
      }
    } catch (error) {
      console.error('Error deleting role:', error)
      alert('Failed to delete role')
    }
  }

  const openEditModal = async (role: Role) => {
    setEditingRole(role)
    
    // Fetch full role data including mobile permissions
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/roles/${role.id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      
      if (response.ok) {
        const data = await response.json()
        const fullRole = data.role
        const mobilePerms = Array.isArray(fullRole.mobilePermissions) 
          ? fullRole.mobilePermissions 
          : []
        
        setFormData({
          name: fullRole.name,
          description: fullRole.description || '',
          permissions: fullRole.permissions.map((rp: any) => rp.permission.key),
          mobilePermissions: mobilePerms,
        })
      } else {
        // Fallback to basic data
        setFormData({
          name: role.name,
          description: role.description || '',
          permissions: role.permissions.map((rp) => rp.permission.key),
          mobilePermissions: [],
        })
      }
    } catch (error) {
      console.error('Error fetching role details:', error)
      setFormData({
        name: role.name,
        description: role.description || '',
        permissions: role.permissions.map((rp) => rp.permission.key),
        mobilePermissions: [],
      })
    }
  }
  
  const toggleMobilePermission = (permissionKey: string) => {
    setFormData((prev) => ({
      ...prev,
      mobilePermissions: prev.mobilePermissions.includes(permissionKey)
        ? prev.mobilePermissions.filter((p) => p !== permissionKey)
        : [...prev.mobilePermissions, permissionKey],
    }))
  }

  const filteredRoles = roles.filter((role) => smartMatch(searchTerm, [role.name, role.description]))

  if (loading) {
    return <div className="p-6">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Roles & Permissions</h1>
          <p className="mt-2 text-gray-600">Manage roles and their permissions</p>
        </div>
        <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
          {canCreate && (
            <DialogTrigger asChild>
              <Button onClick={() => setFormData({ name: '', description: '', permissions: [], mobilePermissions: [] })}>
                <Plus className="mr-2 h-4 w-4" />
                Create Role
              </Button>
            </DialogTrigger>
          )}
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create New Role</DialogTitle>
              <DialogDescription>Define a new role with specific permissions</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Role Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Project Manager"
                />
              </div>
              <div>
                <Label htmlFor="description">Description</Label>
                <textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  rows={3}
                  placeholder="Describe this role's responsibilities..."
                />
              </div>
              <div>
                <Label>Web App — Pages &amp; Actions</Label>
                <div className="mt-2">
                  <RolePermissionModulePicker
                    selectedPermissions={formData.permissions}
                    onChange={(permissions) => setFormData((prev) => ({ ...prev, permissions }))}
                  />
                </div>
              </div>
              <div>
                <Label>Mobile App Permissions</Label>
                <div className="mt-2 space-y-4 max-h-96 overflow-y-auto border rounded-md p-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-sm">Mobile App</h4>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const allSelected = mobilePermissions.every((p) => formData.mobilePermissions.includes(p.key))
                          setFormData((prev) => ({
                            ...prev,
                            mobilePermissions: allSelected ? [] : mobilePermissions.map((p) => p.key),
                          }))
                        }}
                      >
                        {mobilePermissions.every((p) => formData.mobilePermissions.includes(p.key))
                          ? 'Deselect All'
                          : 'Select All'}
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 ml-4">
                      {mobilePermissions.map((perm) => (
                        <label
                          key={perm.key}
                          className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-2 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={formData.mobilePermissions.includes(perm.key)}
                            onChange={() => toggleMobilePermission(perm.key)}
                            className="rounded"
                          />
                          <span className="text-sm">{perm.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateRole}>Create Role</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Roles</CardTitle>
            <div className="flex items-center space-x-2">
              <Search className="h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search roles..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-64"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {filteredRoles.map((role) => (
              <div
                key={role.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50"
              >
                <div className="flex-1">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold">{role.name}</h3>
                    {role.isSystem && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                        System
                      </span>
                    )}
                  </div>
                  {role.description && (
                    <p className="text-sm text-gray-600 mt-1">{role.description}</p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    {role.permissions.length} permissions
                  </p>
                </div>
                <div className="flex items-center space-x-2">
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditModal(role)}
                      title="Edit role permissions"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  )}
                  {canDelete && !role.isSystem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteRole(role.id)}
                      title="Delete role"
                    >
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  )}
                  {!canEdit && !canDelete && (
                    <span className="text-xs text-gray-400">View only</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Edit Modal */}
      {editingRole && (
        <Dialog open={!!editingRole} onOpenChange={() => setEditingRole(null)}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Role</DialogTitle>
              <DialogDescription>Update role permissions</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="edit-name">Role Name</Label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  disabled={editingRole?.isSystem}
                  className={editingRole?.isSystem ? 'bg-gray-100 cursor-not-allowed' : ''}
                />
                {editingRole?.isSystem && (
                  <p className="text-xs text-gray-500 mt-1">System role name cannot be changed</p>
                )}
              </div>
              <div>
                <Label htmlFor="edit-description">Description</Label>
                <textarea
                  id="edit-description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-md ${editingRole?.isSystem ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                  rows={3}
                  disabled={editingRole?.isSystem}
                />
                {editingRole?.isSystem && (
                  <p className="text-xs text-gray-500 mt-1">System role description cannot be changed</p>
                )}
              </div>
              <div>
                <Label>Web App — Pages &amp; Actions</Label>
                <div className="mt-2">
                  <RolePermissionModulePicker
                    selectedPermissions={formData.permissions}
                    onChange={(permissions) => setFormData((prev) => ({ ...prev, permissions }))}
                  />
                </div>
              </div>
              <div>
                <Label>Mobile App Permissions</Label>
                <div className="mt-2 space-y-4 max-h-96 overflow-y-auto border rounded-md p-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-sm">Mobile App</h4>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const allSelected = mobilePermissions.every((p) => formData.mobilePermissions.includes(p.key))
                          setFormData((prev) => ({
                            ...prev,
                            mobilePermissions: allSelected
                              ? []
                              : mobilePermissions.map((p) => p.key),
                          }))
                        }}
                      >
                        {mobilePermissions.every((p) => formData.mobilePermissions.includes(p.key))
                          ? 'Deselect All'
                          : 'Select All'}
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 ml-4">
                      {mobilePermissions.map((perm) => (
                        <label
                          key={perm.key}
                          className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-2 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={formData.mobilePermissions.includes(perm.key)}
                            onChange={() => toggleMobilePermission(perm.key)}
                            className="rounded"
                          />
                          <span className="text-sm">{perm.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingRole(null)}>
                Cancel
              </Button>
              <Button onClick={handleUpdateRole}>Update Role</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
