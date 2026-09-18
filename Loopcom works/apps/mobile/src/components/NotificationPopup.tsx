import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Animated } from 'react-native'
import * as Notifications from 'expo-notifications'
import { colors, spacing, typography } from '../theme/tokens'
import { Ionicons } from '@expo/vector-icons'
import { openFromNotificationPayload } from '../notifications/openFromNotification'

interface NotificationPopupProps {
  notification: Notifications.Notification | null
  onDismiss: () => void
}

export function NotificationPopup({ notification, onDismiss }: NotificationPopupProps) {
  const [fadeAnim] = useState(new Animated.Value(0))
  const [slideAnim] = useState(new Animated.Value(-100))

  useEffect(() => {
    if (notification) {
      // Animate in
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.spring(slideAnim, {
          toValue: 0,
          tension: 50,
          friction: 7,
          useNativeDriver: true,
        }),
      ]).start()

      // Auto-dismiss after 5 seconds
      const timer = setTimeout(() => {
        handleDismiss()
      }, 5000)

      return () => clearTimeout(timer)
    } else {
      // Animate out
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: -100,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start()
    }
  }, [notification])

  const handleDismiss = () => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: -100,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss()
    })
  }

  const handlePress = () => {
    if (!notification) return

    const data = notification.request.content.data as Record<string, any>
    void openFromNotificationPayload(data).catch(() => null)
    handleDismiss()
  }

  if (!notification) return null

  const { title, body } = notification.request.content

  return (
    <Animated.View
      style={[
        styles.container,
        {
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <Pressable style={styles.popup} onPress={handlePress} android_ripple={{ color: 'rgba(255,255,255,0.1)' }}>
        <View style={styles.iconContainer}>
          <Ionicons name="notifications" size={20} color={colors.brandPrimary} />
        </View>
        <View style={styles.content}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {body && (
            <Text style={styles.body} numberOfLines={2}>
              {body}
            </Text>
          )}
        </View>
        <Pressable onPress={handleDismiss} style={styles.closeButton} android_ripple={{ color: 'rgba(255,255,255,0.1)' }}>
          <Ionicons name="close" size={18} color={colors.textSecondary} />
        </Pressable>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 50,
    left: spacing.md,
    right: spacing.md,
    zIndex: 9999,
  },
  popup: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.brandPrimary,
  },
  iconContainer: {
    marginRight: spacing.sm,
  },
  content: {
    flex: 1,
  },
  title: {
    ...typography.sub,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  body: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  closeButton: {
    padding: spacing.xs,
    marginLeft: spacing.sm,
  },
})
