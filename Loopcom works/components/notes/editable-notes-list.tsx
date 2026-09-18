'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/utils'
import { Check, Pencil, Trash2, X } from 'lucide-react'

export interface EditableNoteItem {
  id: string
  content: string
  createdAt: string
  authorName?: string
}

interface EditableNotesListProps {
  notes: EditableNoteItem[]
  emptyMessage?: string
  onUpdate: (noteId: string, content: string) => Promise<void>
  onDelete: (noteId: string) => Promise<void>
  canEdit?: boolean
  variant?: 'border-left' | 'card'
}

export function EditableNotesList({
  notes,
  emptyMessage = 'No notes',
  onUpdate,
  onDelete,
  canEdit = true,
  variant = 'card',
}: EditableNotesListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const startEdit = (note: EditableNoteItem) => {
    setEditingId(note.id)
    setEditText(note.content)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditText('')
  }

  const handleSave = async (noteId: string) => {
    if (!editText.trim()) return
    setSavingId(noteId)
    try {
      await onUpdate(noteId, editText.trim())
      cancelEdit()
    } finally {
      setSavingId(null)
    }
  }

  const handleDelete = async (noteId: string) => {
    if (!confirm('Delete this note?')) return
    setDeletingId(noteId)
    try {
      await onDelete(noteId)
      if (editingId === noteId) cancelEdit()
    } finally {
      setDeletingId(null)
    }
  }

  if (notes.length === 0) {
    return <p className="text-center text-gray-500 py-4">{emptyMessage}</p>
  }

  return (
    <div className="space-y-3">
      {notes.map((note) => {
        const isEditing = editingId === note.id
        const isSaving = savingId === note.id
        const isDeleting = deletingId === note.id

        if (variant === 'border-left') {
          return (
            <div key={note.id} className="border-l-4 border-gray-300 pl-4">
              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    rows={3}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void handleSave(note.id)} disabled={isSaving || !editText.trim()}>
                      <Check className="mr-1 h-3 w-3" />
                      {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={cancelEdit} disabled={isSaving}>
                      <X className="mr-1 h-3 w-3" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap flex-1">{note.content}</p>
                    {canEdit && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={() => startEdit(note)}
                          disabled={isDeleting}
                          aria-label="Edit note"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-red-600 hover:text-red-700"
                          onClick={() => void handleDelete(note.id)}
                          disabled={isDeleting}
                          aria-label="Delete note"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {note.authorName ? `${note.authorName} • ` : ''}
                    {formatDate(note.createdAt)}
                  </p>
                </>
              )}
            </div>
          )
        }

        return (
          <div key={note.id} className="rounded-md border border-gray-200 p-3">
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={3}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void handleSave(note.id)} disabled={isSaving || !editText.trim()}>
                    <Check className="mr-1 h-3 w-3" />
                    {isSaving ? 'Saving...' : 'Save'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEdit} disabled={isSaving}>
                    <X className="mr-1 h-3 w-3" />
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap flex-1">{note.content}</p>
                  {canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => startEdit(note)}
                        disabled={isDeleting}
                        aria-label="Edit note"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-red-600 hover:text-red-700"
                        onClick={() => void handleDelete(note.id)}
                        disabled={isDeleting}
                        aria-label="Delete note"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {note.authorName || 'User'} • {formatDate(note.createdAt)}
                </p>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
