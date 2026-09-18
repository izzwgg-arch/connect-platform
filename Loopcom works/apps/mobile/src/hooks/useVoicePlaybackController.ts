import { useSyncExternalStore } from 'react'
import { Audio, AVPlaybackStatusSuccess } from 'expo-av'

type PlaybackSnapshot = {
  currentMessageId: string | null
  isPlaying: boolean
  positionMs: number
  durationMs: number
  speed: number
}

const listeners = new Set<() => void>()

let sound: Audio.Sound | null = null
let playbackOperationQueue: Promise<void> = Promise.resolve()
let snapshot: PlaybackSnapshot = {
  currentMessageId: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  speed: 1.0,
}

function emit() {
  for (const listener of listeners) listener()
}

function setSnapshot(partial: Partial<PlaybackSnapshot>) {
  snapshot = { ...snapshot, ...partial }
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return snapshot
}

function isLoadedStatus(status: any): status is AVPlaybackStatusSuccess {
  return !!status?.isLoaded
}

function logVoicePlayback(stage: string, payload: Record<string, unknown>) {
  const isFailure = /failed|error|invalid|threw|notLoaded/i.test(stage)
  const logger = isFailure ? console.error : console.warn
  logger(`[VoicePlayback] ${stage}`, payload)
}

function describeUri(uri: string) {
  return {
    uriPreview: uri.slice(0, 180),
    isLocalFile: uri.startsWith('file://') || uri.startsWith('content://'),
  }
}

function enqueuePlaybackOperation<T>(operation: () => Promise<T>) {
  const next = playbackOperationQueue.then(operation, operation)
  playbackOperationQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function cleanupSound(targetSound?: Audio.Sound | null) {
  const currentSound = targetSound ?? sound
  if (!currentSound) return
  try {
    await currentSound.unloadAsync()
  } catch {
    // Ignore unload errors.
  }
  if (!targetSound || sound === targetSound) {
    sound = null
  }
}

async function ensurePlaybackMode() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    })
  } catch (e) {
    logVoicePlayback('setAudioModeAsync', { error: String(e) })
  }
}

export async function playVoiceNote(messageId: string, audioUrl: string) {
  return enqueuePlaybackOperation(async () => {
    const uri = String(audioUrl ?? '').trim()
    if (!messageId || !uri) {
      const err = new Error('Missing messageId or audio URL')
      logVoicePlayback('invalidInput', { messageId, ...describeUri(uri) })
      throw err
    }

    if (sound && snapshot.currentMessageId === messageId) {
      const status = await sound.getStatusAsync()
      if (isLoadedStatus(status) && status.isPlaying) {
        await sound.pauseAsync()
        setSnapshot({
          isPlaying: false,
          positionMs: status.positionMillis || 0,
          durationMs: status.durationMillis || 0,
        })
        return
      }
      if (isLoadedStatus(status)) {
        const duration = status.durationMillis || 0
        const position = status.positionMillis || 0
        const isAtEnd = duration > 0 && position >= Math.max(0, duration - 120)
        if (isAtEnd) {
          await sound.setStatusAsync({ positionMillis: 0, shouldPlay: false, isLooping: false })
        }
      }
      await ensurePlaybackMode()
      try {
        await sound.playAsync()
        setSnapshot({ isPlaying: true })
      } catch (e) {
        logVoicePlayback('resumePlayFailed', { messageId, ...describeUri(uri), error: String(e) })
        await cleanupSound()
        setSnapshot({
          currentMessageId: null,
          isPlaying: false,
          positionMs: 0,
          durationMs: 0,
        })
        throw e instanceof Error ? e : new Error(String(e))
      }
      return
    }

    await cleanupSound()
    await ensurePlaybackMode()

    let newSound: Audio.Sound
    try {
      const created = await Audio.Sound.createAsync(
        { uri },
        {
          shouldPlay: false,
          progressUpdateIntervalMillis: 50,
          isLooping: false,
          volume: 1.0,
        }
      )
      newSound = created.sound
    } catch (e) {
      logVoicePlayback('createAsyncFailed', {
        messageId,
        ...describeUri(uri),
        error: String(e),
      })
      throw e instanceof Error ? e : new Error(String(e))
    }

    const statusAfterCreate = await newSound.getStatusAsync()
    if (!isLoadedStatus(statusAfterCreate)) {
      const errDetail =
        'error' in statusAfterCreate && statusAfterCreate.error
          ? String(statusAfterCreate.error)
          : 'Audio source did not load (invalid URL, network, or format)'
      logVoicePlayback('notLoadedAfterCreate', {
        messageId,
        ...describeUri(uri),
        status: JSON.stringify(statusAfterCreate),
      })
      await cleanupSound(newSound)
      throw new Error(errDetail)
    }

    sound = newSound
    setSnapshot({
      currentMessageId: messageId,
      isPlaying: false,
      positionMs: statusAfterCreate.positionMillis || 0,
      durationMs: statusAfterCreate.durationMillis || 0,
    })

    newSound.setOnPlaybackStatusUpdate((st) => {
      if (!isLoadedStatus(st)) {
        if ('error' in st && st.error) {
          logVoicePlayback('playbackStatusError', { messageId, ...describeUri(uri), error: String(st.error) })
          void enqueuePlaybackOperation(async () => {
            await cleanupSound(newSound)
            setSnapshot({
              currentMessageId: null,
              isPlaying: false,
              positionMs: 0,
              durationMs: 0,
            })
          })
        }
        return
      }
      const durationMs = st.durationMillis || snapshot.durationMs || 0
      const positionMs = st.positionMillis || 0
      if (st.didJustFinish) {
        void sound?.setStatusAsync({ shouldPlay: false, isLooping: false, positionMillis: 0 }).catch(() => {})
        setSnapshot({
          currentMessageId: messageId,
          isPlaying: false,
          positionMs: 0,
          durationMs,
        })
        return
      }
      setSnapshot({
        currentMessageId: messageId,
        isPlaying: st.isPlaying,
        positionMs,
        durationMs,
      })
    })

    try {
      await newSound.playAsync()
      setSnapshot({ isPlaying: true })
    } catch (e) {
      logVoicePlayback('playAsyncFailed', { messageId, ...describeUri(uri), error: String(e) })
      await cleanupSound(newSound)
      setSnapshot({
        currentMessageId: null,
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
      })
      throw e instanceof Error ? e : new Error(String(e))
    }
  })
}

export async function pauseVoiceNote() {
  return enqueuePlaybackOperation(async () => {
    if (!sound) return
    const status = await sound.getStatusAsync()
    if (!isLoadedStatus(status) || !status.isPlaying) return
    await sound.pauseAsync()
    setSnapshot({
      isPlaying: false,
      positionMs: status.positionMillis || snapshot.positionMs,
      durationMs: status.durationMillis || snapshot.durationMs,
    })
  })
}

export async function seekVoiceNote(messageId: string, ratio: number) {
  return enqueuePlaybackOperation(async () => {
    if (!sound || snapshot.currentMessageId !== messageId) return
    const status = await sound.getStatusAsync()
    if (!isLoadedStatus(status)) return
    const duration = status.durationMillis || snapshot.durationMs || 0
    if (duration <= 0) return

    const clampedRatio = Math.max(0, Math.min(1, ratio))
    const target = Math.round(duration * clampedRatio)
    await sound.setPositionAsync(target)
    setSnapshot({
      currentMessageId: messageId,
      isPlaying: status.isPlaying,
      positionMs: target,
      durationMs: duration,
    })
  })
}

export async function setSpeedVoiceNote(messageId: string, rate: number) {
  return enqueuePlaybackOperation(async () => {
    if (!sound || snapshot.currentMessageId !== messageId) return
    const status = await sound.getStatusAsync()
    if (!isLoadedStatus(status)) return
    await sound.setRateAsync(rate, true)
    setSnapshot({ speed: rate })
  })
}

export async function stopVoiceNote() {
  return enqueuePlaybackOperation(async () => {
    if (!sound) return
    try {
      await sound.stopAsync()
    } catch {
      // Ignore stop errors.
    }
    await cleanupSound()
    setSnapshot({
      currentMessageId: null,
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
    })
  })
}

export function useVoicePlaybackController(messageId: string) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const isCurrent = state.currentMessageId === messageId
  return {
    isPlaying: isCurrent && state.isPlaying,
    positionMs: isCurrent ? state.positionMs : 0,
    durationMs: isCurrent ? state.durationMs : 0,
    speed: isCurrent ? state.speed : 1.0,
    isActiveTrack: isCurrent,
    currentPlayingMessageId: state.currentMessageId,
    play: (url: string) => playVoiceNote(messageId, url),
    pause: () => pauseVoiceNote(),
    seek: (ratio: number) => seekVoiceNote(messageId, ratio),
    setSpeed: (rate: number) => setSpeedVoiceNote(messageId, rate),
    stop: () => stopVoiceNote(),
  }
}
