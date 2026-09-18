'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ViewModeSelector } from '@/components/ui/ViewModeSelector'
import { useViewMode } from '@/hooks/useViewMode'
import { usePersistedSort } from '@/hooks/useListPreferences'
import { RowCompactItem } from '@/components/lists/RowCompactItem'
import { RowDetailedItem } from '@/components/lists/RowDetailedItem'
import { TableView } from '@/components/lists/TableView'
import { Users, Plus, Search, Mail, Phone, Briefcase, X, Pencil, Trash2 } from 'lucide-react'
import { smartMatch } from '@/lib/search/scoring'
import { JOB_TYPES } from '@/lib/jobs/types'

const ALLOWED_BASE_ROLES = new Set(['ADMIN', 'MANAGER', 'OFFICE', 'FIELD', 'SALES', 'ACCOUNTING'])

function deriveBaseRole(roleName: string): string {
  const upper = roleName.trim().toUpperCase()
  return ALLOWED_BASE_ROLES.has(upper) ? upper : 'OFFICE'
}

function toggleJobType(current: string[], value: string): string[] {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
}

interface TeamMember {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  role: string
  allowWebLogin: boolean
  allowMobileLogin: boolean
  assignedJobTypes?: string[]
  roleId?: string | null
  roleName?: string | null
  managerId?: string | null
  manager?: {
    id: string
    firstName: string
    lastName: string
    email: string
    role: string
  } | null
  status: string
  _count: {
    schedules: number
  }
}

interface AvailableRole {
  id: string
  name: string
  isSystem: boolean
  isActive: boolean
}

export default function TeamsPage() {
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [editError, setEditError] = useState('')
  const [inviteSuccess, setInviteSuccess] = useState(false)
  const [inviteSuccessMessage, setInviteSuccessMessage] = useState('')
  const [reinviteLoadingById, setReinviteLoadingById] = useState<Record<string, boolean>>({})
  const [deleteLoadingById, setDeleteLoadingById] = useState<Record<string, boolean>>({})
  const [viewMode, setViewMode] = useViewMode('team', 'grid')
  const { sortKey: persistedSortKey, sortDirection: persistedSortDirection, setSort: setPersistedSort } =
    usePersistedSort('teams')
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [availableRoles, setAvailableRoles] = useState<AvailableRole[]>([])
  const [inviteForm, setInviteForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    role: 'FIELD',
    roleId: '',
    allowWebLogin: true,
    allowMobileLogin: true,
    assignedJobTypes: [] as string[],
  })
  const [editForm, setEditForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    role: 'FIELD' as 'ADMIN' | 'MANAGER' | 'OFFICE' | 'FIELD' | 'SALES' | 'ACCOUNTING',
    roleId: '',
    managerId: null as string | null,
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE' | 'INVITED' | 'SUSPENDED',
    allowWebLogin: true,
    allowMobileLogin: true,
    assignedJobTypes: [] as string[],
  })

  useEffect(() => {
    fetchTeam()
    fetchRoles()
  }, [])

  const fetchTeam = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/schedules/team', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401) {
        window.location.href = '/auth/login'
        return
      }

      if (response.ok) {
        const data = await response.json()
        setTeamMembers(data.teamMembers || [])
      }
    } catch (error) {
      console.error('Error fetching team:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchRoles = async () => {
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/roles', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return
      const data = await response.json()
      const roles = Array.isArray(data.roles) ? data.roles : []
      setAvailableRoles(
        roles
          .filter((role: any) => role?.isActive !== false)
          .map((role: any) => ({
            id: role.id,
            name: String(role.name || '').trim(),
            isSystem: Boolean(role.isSystem),
            isActive: Boolean(role.isActive),
          }))
          .filter((role: AvailableRole) => role.name.length > 0)
      )
    } catch (error) {
      console.error('Error fetching roles for invite selector:', error)
    }
  }

  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setInviteError('')
    setInviteSuccess(false)
    setInviteSuccessMessage('')
    setInviteLoading(true)

    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch('/api/users/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(inviteForm),
      })

      if (response.status === 401) {
        window.location.href = '/auth/login'
        return
      }

      const data = await response.json()

      if (!response.ok) {
        setInviteError(data.error || 'Failed to invite user')
        setInviteLoading(false)
        return
      }

      setInviteSuccess(true)
      setInviteSuccessMessage(
        data.emailSent === false
          ? `User invited, but email send failed: ${data.emailError || 'Unknown email provider error'}`
          : 'User invited successfully! The invitation email has been sent.'
      )
      const defaultRole = roleOptions[0] || { id: '', name: 'FIELD' }
      setInviteForm({
        email: '',
        firstName: '',
        lastName: '',
        phone: '',
        role: deriveBaseRole(defaultRole.name),
        roleId: defaultRole.id,
        allowWebLogin: true,
        allowMobileLogin: true,
        assignedJobTypes: [],
      })
      
      // Refresh team list
      await fetchTeam()
      
      // Close modal after 2 seconds
      setTimeout(() => {
        setShowInviteModal(false)
        setInviteSuccess(false)
      }, 2000)
    } catch (error) {
      console.error('Error inviting user:', error)
      setInviteError('An error occurred. Please try again.')
    } finally {
      setInviteLoading(false)
    }
  }

  const handleReinvite = async (member: TeamMember) => {
    setReinviteLoadingById((prev) => ({ ...prev, [member.id]: true }))
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/users/${member.id}/reinvite`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        window.location.href = '/auth/login'
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to resend invitation email')
        return
      }

      alert('Invitation email sent successfully.')
      await fetchTeam()
    } catch (error) {
      console.error('Error reinviting user:', error)
      alert('Failed to resend invitation email')
    } finally {
      setReinviteLoadingById((prev) => ({ ...prev, [member.id]: false }))
    }
  }

  const handleDeleteUser = async (member: TeamMember) => {
    const confirmed = window.confirm(
      `Delete ${member.firstName} ${member.lastName}? This cannot be undone.`
    )
    if (!confirmed) return

    setDeleteLoadingById((prev) => ({ ...prev, [member.id]: true }))
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/users/${member.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (response.status === 401) {
        window.location.href = '/auth/login'
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        alert(data.error || 'Failed to delete user')
        return
      }

      await fetchTeam()
      alert('User deleted successfully.')
    } catch (error) {
      console.error('Error deleting user:', error)
      alert('Failed to delete user')
    } finally {
      setDeleteLoadingById((prev) => ({ ...prev, [member.id]: false }))
    }
  }

  const openEditModal = (member: TeamMember) => {
    const matchingRole =
      roleOptions.find((role) => role.id === (member.roleId || '')) ||
      roleOptions.find((role) => role.name.toUpperCase() === String(member.role || '').toUpperCase()) ||
      roleOptions.find((role) => role.name.toUpperCase() === String(member.roleName || '').toUpperCase()) ||
      roleOptions[0]

    setEditingUserId(member.id)
    setEditError('')
    setEditForm({
      firstName: member.firstName || '',
      lastName: member.lastName || '',
      email: member.email || '',
      phone: member.phone || '',
      role: deriveBaseRole(matchingRole?.name || member.role || 'FIELD') as any,
      roleId: matchingRole?.id || '',
      managerId: member.managerId || null,
      status: member.status as any,
      allowWebLogin: member.allowWebLogin !== false,
      allowMobileLogin: member.allowMobileLogin !== false,
      assignedJobTypes: Array.isArray(member.assignedJobTypes) ? [...member.assignedJobTypes] : [],
    })
    setShowEditModal(true)
  }

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingUserId) return

    setEditLoading(true)
    setEditError('')
    try {
      const token = localStorage.getItem('accessToken')
      const response = await fetch(`/api/users/${editingUserId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(editForm),
      })

      if (response.status === 401) {
        window.location.href = '/auth/login'
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setEditError(data.error || 'Failed to update user')
        return
      }

      setShowEditModal(false)
      setEditingUserId(null)
      await fetchTeam()
    } catch (error) {
      console.error('Error updating user:', error)
      setEditError('Failed to update user')
    } finally {
      setEditLoading(false)
    }
  }

  const filteredMembers = teamMembers.filter((member) =>
    smartMatch(search, [member.firstName, member.lastName, member.email, member.role, member.phone])
  )

  const roleColors: Record<string, string> = {
    ADMIN: 'bg-purple-100 text-purple-800',
    MANAGER: 'bg-indigo-100 text-indigo-800',
    OFFICE: 'bg-blue-100 text-blue-800',
    FIELD: 'bg-green-100 text-green-800',
    SALES: 'bg-yellow-100 text-yellow-800',
    ACCOUNTING: 'bg-pink-100 text-pink-800',
  }
  const managerUsers = teamMembers.filter((member) => member.role === 'MANAGER')
  const managerOptions = managerUsers.filter((manager) => manager.id !== editingUserId)
  const fallbackRoleOptions: AvailableRole[] = [
    { id: 'FIELD', name: 'FIELD', isSystem: true, isActive: true },
    { id: 'MANAGER', name: 'MANAGER', isSystem: true, isActive: true },
    { id: 'OFFICE', name: 'OFFICE', isSystem: true, isActive: true },
    { id: 'SALES', name: 'SALES', isSystem: true, isActive: true },
    { id: 'ACCOUNTING', name: 'ACCOUNTING', isSystem: true, isActive: true },
    { id: 'ADMIN', name: 'ADMIN', isSystem: true, isActive: true },
  ]
  const roleOptions = availableRoles.length > 0 ? availableRoles : fallbackRoleOptions
  const renderMemberActions = (member: TeamMember) => (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => openEditModal(member)}>
        <Pencil className="mr-2 h-4 w-4" />
        Edit
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => handleReinvite(member)}
        disabled={!!reinviteLoadingById[member.id]}
      >
        {reinviteLoadingById[member.id] ? 'Sending...' : 'Reinvite'}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => handleDeleteUser(member)}
        disabled={!!deleteLoadingById[member.id]}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {deleteLoadingById[member.id] ? 'Deleting...' : 'Delete'}
      </Button>
    </div>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600">Loading team...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Team Management</h1>
          <p className="mt-2 text-gray-600">View and manage your team members</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeSelector value={viewMode} onChange={setViewMode} />
          <Button onClick={() => setShowInviteModal(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Invite User
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center space-x-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search team members..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {viewMode === 'grid' ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredMembers.map((member) => (
            <Card key={member.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">
                    {member.firstName} {member.lastName}
                  </CardTitle>
                  <span className={`px-2 py-1 text-xs font-semibold rounded-full ${roleColors[member.role] || 'bg-gray-100 text-gray-800'}`}>
                    {member.role}
                  </span>
                </div>
                <CardDescription>
                  {member.status === 'ACTIVE' ? <span className="text-green-600">Active</span> : <span className="text-gray-500">{member.status}</span>}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center text-sm text-gray-600">
                  <Mail className="mr-2 h-4 w-4" />
                  {member.email}
                </div>
                {member.phone && (
                  <div className="flex items-center text-sm text-gray-600">
                    <Phone className="mr-2 h-4 w-4" />
                    {member.phone}
                  </div>
                )}
                <div className="flex items-center text-sm text-gray-600">
                  <Briefcase className="mr-2 h-4 w-4" />
                  {member._count.schedules} scheduled items
                </div>
                {member.role === 'FIELD' && (
                  <div className="text-xs text-gray-500">
                    Manager:{' '}
                    {member.manager
                      ? `${member.manager.firstName} ${member.manager.lastName}`.trim() || member.manager.email
                      : 'Unassigned'}
                  </div>
                )}
                {renderMemberActions(member)}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : viewMode === 'rowCompact' ? (
        <div className="space-y-2">
          {filteredMembers.map((member) => (
            <RowCompactItem
              key={member.id}
              primary={`${member.firstName} ${member.lastName}`}
              secondary={member.email}
              status={<span className={`px-2 py-1 text-xs rounded-full ${roleColors[member.role] || 'bg-gray-100 text-gray-800'}`}>{member.role}</span>}
              amount={member.status}
              date={`${member._count.schedules} schedules${member.role === 'FIELD' ? ` \u2022 Manager: ${member.manager ? `${member.manager.firstName} ${member.manager.lastName}`.trim() || member.manager.email : 'Unassigned'}` : ''}`}
              actions={renderMemberActions(member)}
            />
          ))}
        </div>
      ) : viewMode === 'rowDetailed' ? (
        <div className="space-y-2">
          {filteredMembers.map((member) => (
            <RowDetailedItem
              key={member.id}
              primary={`${member.firstName} ${member.lastName}`}
              status={<span className={`px-2 py-1 text-xs rounded-full ${roleColors[member.role] || 'bg-gray-100 text-gray-800'}`}>{member.role}</span>}
              line2={`${member.email}${member.phone ? ` \u2022 ${member.phone}` : ''}${member.role === 'FIELD' ? ` \u2022 Manager: ${member.manager ? `${member.manager.firstName} ${member.manager.lastName}`.trim() || member.manager.email : 'Unassigned'}` : ''}`}
              rightTop={member.status}
              rightBottom={`${member._count.schedules} schedules`}
              actions={renderMemberActions(member)}
            />
          ))}
        </div>
      ) : (
        <TableView
          data={filteredMembers}
          rowKey={(member) => member.id}
          sortKey={persistedSortKey}
          sortDirection={persistedSortDirection}
          onSortChange={setPersistedSort}
          columns={[
            {
              key: 'name',
              header: 'Name',
              sortValue: (member) => `${member.firstName} ${member.lastName}`,
              render: (member) => <span className="font-medium">{member.firstName} {member.lastName}</span>,
            },
            {
              key: 'role',
              header: 'Role',
              sortValue: (member) => member.role,
              render: (member) => <span className={`px-2 py-1 text-xs rounded-full ${roleColors[member.role] || 'bg-gray-100 text-gray-800'}`}>{member.role}</span>,
            },
            {
              key: 'manager',
              header: 'Manager',
              sortValue: (member) =>
                member.role === 'FIELD'
                  ? member.manager
                    ? `${member.manager.firstName} ${member.manager.lastName}`.trim() || member.manager.email
                    : 'Unassigned'
                  : '',
              render: (member) =>
                member.role === 'FIELD'
                  ? (member.manager
                      ? `${member.manager.firstName} ${member.manager.lastName}`.trim() || member.manager.email
                      : 'Unassigned')
                  : '—',
            },
            {
              key: 'email',
              header: 'Email',
              sortValue: (member) => member.email,
              render: (member) => member.email,
            },
            {
              key: 'status',
              header: 'Status',
              sortValue: (member) => member.status,
              render: (member) => member.status,
            },
            {
              key: 'schedules',
              header: 'Schedules',
              sortValue: (member) => member._count.schedules,
              render: (member) => member._count.schedules,
            },
            {
              key: 'actions',
              header: 'Actions',
              render: (member) => renderMemberActions(member),
            },
          ]}
        />
      )}

      {filteredMembers.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-4 text-lg font-medium text-gray-900">No team members found</h3>
            <p className="mt-2 text-gray-600">
              {search ? 'Try adjusting your search' : 'Get started by inviting team members'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Invite User Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md m-4">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Invite New User</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowInviteModal(false)
                    setInviteError('')
                    setInviteSuccess(false)
                    setInviteForm({
                      email: '',
                      firstName: '',
                      lastName: '',
                      phone: '',
                      role: deriveBaseRole(roleOptions[0]?.name || 'FIELD'),
                      roleId: roleOptions[0]?.id || 'FIELD',
                      allowWebLogin: true,
                      allowMobileLogin: true,
                      assignedJobTypes: [],
                    })
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>Send an invitation to a new team member</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleInviteUser} className="space-y-4">
                {inviteError && (
                  <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
                    {inviteError}
                  </div>
                )}
                {inviteSuccess && (
                  <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded">
                    {inviteSuccessMessage || 'User invited successfully!'}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="firstName">First Name *</Label>
                    <Input
                      id="firstName"
                      value={inviteForm.firstName}
                      onChange={(e) => setInviteForm({ ...inviteForm, firstName: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="lastName">Last Name *</Label>
                    <Input
                      id="lastName"
                      value={inviteForm.lastName}
                      onChange={(e) => setInviteForm({ ...inviteForm, lastName: e.target.value })}
                      required
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={inviteForm.email}
                    onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={inviteForm.phone}
                    onChange={(e) => setInviteForm({ ...inviteForm, phone: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="role">Role *</Label>
                  <Select
                    value={inviteForm.roleId || roleOptions[0]?.id}
                    onValueChange={(value) => {
                      const selectedRole = roleOptions.find((role) => role.id === value)
                      setInviteForm({
                        ...inviteForm,
                        roleId: value,
                        role: deriveBaseRole(selectedRole?.name || 'FIELD'),
                      })
                    }}
                  >
                    <SelectTrigger id="role">
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-md border p-3 space-y-3">
                  <p className="text-sm font-medium">App Access</p>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Allow web app login</span>
                    <input
                      type="checkbox"
                      checked={inviteForm.allowWebLogin}
                      onChange={(e) => setInviteForm({ ...inviteForm, allowWebLogin: e.target.checked })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Allow phone app login</span>
                    <input
                      type="checkbox"
                      checked={inviteForm.allowMobileLogin}
                      onChange={(e) => setInviteForm({ ...inviteForm, allowMobileLogin: e.target.checked })}
                    />
                  </label>
                </div>
                <div className="rounded-md border p-3 space-y-3">
                  <p className="text-sm font-medium">Job Types</p>
                  <p className="text-xs text-gray-500">
                    Leave empty until you assign types. Users without Access All Job Types only see jobs/requests for their selected types.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {JOB_TYPES.map((type) => (
                      <label key={type.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={inviteForm.assignedJobTypes.includes(type.value)}
                          onChange={() =>
                            setInviteForm({
                              ...inviteForm,
                              assignedJobTypes: toggleJobType(inviteForm.assignedJobTypes, type.value),
                            })
                          }
                        />
                        {type.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex space-x-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowInviteModal(false)
                      setInviteError('')
                      setInviteSuccess(false)
                      setInviteForm({
                        email: '',
                        firstName: '',
                        lastName: '',
                        phone: '',
                        role: deriveBaseRole(roleOptions[0]?.name || 'FIELD'),
                        roleId: roleOptions[0]?.id || 'FIELD',
                        allowWebLogin: true,
                        allowMobileLogin: true,
                        assignedJobTypes: [],
                      })
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" className="flex-1" disabled={inviteLoading}>
                    {inviteLoading ? 'Sending...' : 'Send Invitation'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Edit User Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md m-4">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Edit User</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowEditModal(false)
                    setEditingUserId(null)
                    setEditError('')
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>Update team member details</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleEditUser} className="space-y-4">
                {editError && (
                  <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
                    {editError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="editFirstName">First Name *</Label>
                    <Input
                      id="editFirstName"
                      value={editForm.firstName}
                      onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="editLastName">Last Name *</Label>
                    <Input
                      id="editLastName"
                      value={editForm.lastName}
                      onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                      required
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="editEmail">Email *</Label>
                  <Input
                    id="editEmail"
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="editPhone">Phone</Label>
                  <Input
                    id="editPhone"
                    type="tel"
                    value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="editRole">Role *</Label>
                  <Select
                    value={editForm.roleId || roleOptions.find((role) => deriveBaseRole(role.name) === editForm.role)?.id}
                    onValueChange={(value) => {
                      const selectedRole = roleOptions.find((role) => role.id === value)
                      const normalizedRole = deriveBaseRole(selectedRole?.name || 'FIELD')
                      setEditForm((prev) => ({
                        ...prev,
                        roleId: value,
                        role: normalizedRole as any,
                        managerId: normalizedRole === 'FIELD' ? prev.managerId : null,
                      }))
                    }}
                  >
                    <SelectTrigger id="editRole">
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {editForm.role === 'FIELD' && (
                  <div>
                    <Label htmlFor="editManager">Manager</Label>
                    <Select
                      value={editForm.managerId || '__none__'}
                      onValueChange={(value) =>
                        setEditForm((prev) => ({ ...prev, managerId: value === '__none__' ? null : value }))
                      }
                      disabled={managerOptions.length === 0}
                    >
                      <SelectTrigger id="editManager">
                        <SelectValue placeholder="Select manager" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Unassigned</SelectItem>
                        {managerOptions.map((manager) => (
                          <SelectItem key={manager.id} value={manager.id}>
                            {`${manager.firstName} ${manager.lastName}`.trim() || manager.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {managerOptions.length === 0 && (
                      <p className="mt-1 text-xs text-gray-500">No managers available</p>
                    )}
                  </div>
                )}
                <div>
                  <Label htmlFor="editStatus">Status *</Label>
                  <Select
                    value={editForm.status}
                    onValueChange={(value) => setEditForm({ ...editForm, status: value as any })}
                  >
                    <SelectTrigger id="editStatus">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="INACTIVE">Inactive</SelectItem>
                      <SelectItem value="INVITED">Invited</SelectItem>
                      <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-md border p-3 space-y-3">
                  <p className="text-sm font-medium">App Access</p>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Allow web app login</span>
                    <input
                      type="checkbox"
                      checked={editForm.allowWebLogin}
                      onChange={(e) => setEditForm({ ...editForm, allowWebLogin: e.target.checked })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Allow phone app login</span>
                    <input
                      type="checkbox"
                      checked={editForm.allowMobileLogin}
                      onChange={(e) => setEditForm({ ...editForm, allowMobileLogin: e.target.checked })}
                    />
                  </label>
                </div>
                <div className="rounded-md border p-3 space-y-3">
                  <p className="text-sm font-medium">Job Types</p>
                  <p className="text-xs text-gray-500">
                    Leave empty until you assign types. Users without Access All Job Types only see jobs/requests for their selected types.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {JOB_TYPES.map((type) => (
                      <label key={type.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={editForm.assignedJobTypes.includes(type.value)}
                          onChange={() =>
                            setEditForm({
                              ...editForm,
                              assignedJobTypes: toggleJobType(editForm.assignedJobTypes, type.value),
                            })
                          }
                        />
                        {type.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex space-x-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowEditModal(false)
                      setEditingUserId(null)
                      setEditError('')
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" className="flex-1" disabled={editLoading}>
                    {editLoading ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
