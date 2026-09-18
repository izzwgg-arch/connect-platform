import React, { useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'

interface User {
  id: string
  firstName?: string | null
  lastName?: string | null
  email: string
}

interface StartMessageSheetProps {
  visible: boolean
  users: User[]
  onClose: () => void
  onSelectUser: (userId: string) => void
  onSelectTeam: () => void
}

function displayName(user: User) {
  const full = `${user.firstName || ''} ${user.lastName || ''}`.trim()
  return full || user.email
}

export function StartMessageSheet({ visible, users, onClose, onSelectUser, onSelectTeam }: StartMessageSheetProps) {
  const [search, setSearch] = useState('')

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => {
      const name = displayName(u).toLowerCase()
      return name.includes(q) || u.email.toLowerCase().includes(q)
    })
  }, [users, search])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>New Message</Text>
            <Pressable onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </Pressable>
          </View>

          <Pressable style={styles.teamOption} onPress={onSelectTeam}>
            <View style={styles.teamIcon}>
              <Ionicons name="people" size={20} color={colors.brandPrimary} />
            </View>
            <View style={styles.teamContent}>
              <Text style={styles.teamTitle}>Team Chat</Text>
              <Text style={styles.teamSubtitle}>Message the whole team</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>

          <View style={styles.divider} />

          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search team members..."
            placeholderTextColor={colors.textSecondary}
          />

          <FlatList
            data={filteredUsers}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const name = displayName(item)
              const initials = name.charAt(0).toUpperCase()
              return (
                <Pressable
                  style={styles.userRow}
                  onPress={() => {
                    onSelectUser(item.id)
                    onClose()
                  }}
                  android_ripple={{ color: 'rgba(15,23,42,0.06)' }}
                >
                  <View style={styles.userAvatar}>
                    <Text style={styles.userAvatarText}>{initials}</Text>
                  </View>
                  <View style={styles.userContent}>
                    <Text style={styles.userName}>{name}</Text>
                    <Text style={styles.userEmail}>{item.email}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                </Pressable>
              )
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>No users found</Text>
              </View>
            }
          />
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    paddingBottom: spacing.xl,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: colors.divider,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  closeButton: {
    padding: spacing.xs,
  },
  teamOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  teamIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brandPrimary + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamContent: {
    flex: 1,
    gap: 2,
  },
  teamTitle: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  teamSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: spacing.sm,
  },
  searchInput: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 10,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.divider,
    ...typography.body,
    color: colors.textPrimary,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  userAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brandPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userAvatarText: {
    ...typography.sub,
    color: colors.surface,
    fontWeight: '600',
  },
  userContent: {
    flex: 1,
    gap: 2,
  },
  userName: {
    ...typography.sub,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  userEmail: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  empty: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
})
