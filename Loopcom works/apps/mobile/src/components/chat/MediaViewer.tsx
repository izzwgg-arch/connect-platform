import React, { useRef, useState } from 'react'
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av'
import { colors, spacing } from '../../theme/tokens'

interface MediaViewerProps {
  visible: boolean
  uri: string
  fileName?: string | null
  kind: 'IMAGE' | 'VIDEO'
  onClose: () => void
}

export function MediaViewer({ visible, uri, fileName, kind, onClose }: MediaViewerProps) {
  const videoRef = useRef<Video>(null)
  const [videoLoading, setVideoLoading] = useState(true)
  const [videoError, setVideoError] = useState(false)

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (status.isLoaded) {
      setVideoLoading(false)
      setVideoError(false)
    }
  }

  const handleVideoError = () => {
    setVideoLoading(false)
    setVideoError(true)
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.container}>
        <Pressable style={styles.closeButton} onPress={onClose}>
          <Ionicons name="close" size={28} color={colors.surface} />
        </Pressable>
        {kind === 'IMAGE' ? (
          <Image source={{ uri }} style={styles.image} resizeMode="contain" />
        ) : videoError ? (
          <View style={styles.videoPlaceholder}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.surface + 'AA'} />
            <Text style={styles.videoText}>Unable to play video</Text>
          </View>
        ) : (
          <View style={styles.videoWrap}>
            {videoLoading && (
              <View style={styles.videoLoadingOverlay}>
                <ActivityIndicator size="large" color={colors.surface} />
              </View>
            )}
            <Video
              ref={videoRef}
              source={{ uri }}
              style={styles.video}
              resizeMode={ResizeMode.CONTAIN}
              useNativeControls
              shouldPlay
              onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
              onError={handleVideoError}
            />
          </View>
        )}
        {fileName && (
          <View style={styles.footer}>
            <Text style={styles.fileName} numberOfLines={1}>
              {fileName}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: spacing.xl,
    right: spacing.md,
    zIndex: 1,
    padding: spacing.sm,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  videoWrap: {
    width: '100%',
    height: '80%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  videoLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  videoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  videoText: {
    color: colors.surface,
    fontSize: 16,
  },
  footer: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.md,
    right: spacing.md,
    alignItems: 'center',
  },
  fileName: {
    color: colors.surface,
    fontSize: 14,
  },
})
