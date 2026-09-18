import { Audio } from 'expo-av'

type RecorderPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'canceling'

export interface VoiceStopResult {
  uri: string
  durationMs: number
  mime: string
}

export class VoiceRecorder {
  private recording: Audio.Recording | null = null
  private phase: RecorderPhase = 'idle'
  private activeOperation: Promise<void> | null = null
  private permissionGranted: boolean | null = null
  private recordingStartedAt: number | null = null
  private didObserveRecordingStart = false

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async safeStopAndUnload(current: Audio.Recording): Promise<void> {
    try {
      const status = await current.getStatusAsync()
      if (!('isRecording' in status) || !status.isRecording) {
        return
      }
      await current.stopAndUnloadAsync()
    } catch {
    }
  }

  private getRecordingOptions(): Audio.RecordingOptions {
    return {
      isMeteringEnabled: false,
      android: {
        extension: '.m4a',
        outputFormat: Audio.AndroidOutputFormat.MPEG_4,
        audioEncoder: Audio.AndroidAudioEncoder.AAC,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitRate: 128000,
      },
      ios: {
        extension: '.m4a',
        audioQuality: Audio.IOSAudioQuality.HIGH,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitRate: 128000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      web: {
        mimeType: 'audio/webm',
        bitsPerSecond: 128000,
      },
    }
  }

  isRecording() {
    return this.phase === 'recording'
  }

  getPhase() {
    return this.phase
  }

  private getAudioModeOptions(allowsRecording: boolean) {
    return {
      allowsRecordingIOS: allowsRecording,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false,
    }
  }

  async ensurePermission(interactive: boolean): Promise<boolean> {
    if (this.permissionGranted === true) return true
    const current = await Audio.getPermissionsAsync()
    if (current.granted) {
      this.permissionGranted = true
      return true
    }
    if (!interactive) {
      this.permissionGranted = false
      return false
    }
    const requested = await Audio.requestPermissionsAsync()
    this.permissionGranted = requested.granted
    return requested.granted
  }

  async start(): Promise<void> {
    if (this.phase === 'starting' || this.phase === 'recording' || this.phase === 'stopping' || this.phase === 'canceling') {
      return
    }

    const run = async () => {
      this.transition('starting')
      try {
        await this.forceCleanup()
        const granted = await this.ensurePermission(false)
        if (!granted) {
          throw new Error('Microphone permission denied')
        }

        await Audio.setAudioModeAsync(this.getAudioModeOptions(true))

        const recording = new Audio.Recording()
        await recording.prepareToRecordAsync(this.getRecordingOptions())
        await recording.startAsync()
        this.recording = recording
        this.didObserveRecordingStart = false
        const bootWaitUntil = Date.now() + 1200
        while (Date.now() < bootWaitUntil) {
          const status = await this.recording.getStatusAsync()
          if ('isRecording' in status && status.isRecording) {
            this.didObserveRecordingStart = true
            break
          }
          await this.sleep(60)
        }
        if (!this.didObserveRecordingStart) {
          throw new Error('Recorder failed to start')
        }
        this.recordingStartedAt = Date.now()
        this.transition('recording')
      } catch (error: any) {
        await this.forceCleanup()
        this.transition('idle')
        throw error
      } finally {
        this.activeOperation = null
      }
    }

    this.activeOperation = run()
    return this.activeOperation
  }

  async stop(): Promise<VoiceStopResult> {
    if (this.phase === 'starting' && this.activeOperation) {
      await this.activeOperation
    }
    if (this.phase === 'stopping' || this.phase === 'canceling') {
      throw new Error('Recorder busy')
    }
    if (!this.recording) {
      throw new Error('No active recording')
    }

    const run = async () => {
      this.transition('stopping')
      try {
        const current = this.recording
        if (!current) throw new Error('No active recording')
        const minRecordingMs = 650
        const elapsed = this.recordingStartedAt ? Date.now() - this.recordingStartedAt : 0
        if (elapsed < minRecordingMs) {
          await new Promise((resolve) => setTimeout(resolve, minRecordingMs - elapsed))
        }
        const status = await current.getStatusAsync()
        if (!('isRecording' in status) || !status.isRecording || !this.didObserveRecordingStart) {
          throw new Error('Recorder is not in recording state')
        }
        const uri = current.getURI()
        const durationMs = 'durationMillis' in status ? status.durationMillis || 0 : 0
        try {
          await current.stopAndUnloadAsync()
        } catch {
          // Some Android devices briefly report recording=true while recorder is transitioning.
          await this.sleep(120)
          const retryStatus = await current.getStatusAsync()
          if ('isRecording' in retryStatus && retryStatus.isRecording) {
            await current.stopAndUnloadAsync()
          } else {
            throw new Error('Recorder stop failed')
          }
        }
        this.recording = null
        this.recordingStartedAt = null
        this.didObserveRecordingStart = false

        await this.resetAudioMode()
        this.transition('idle')

        if (!uri) throw new Error('Recording URI is unavailable')
        return { uri, durationMs, mime: 'audio/m4a' }
      } catch (error: any) {
        await this.forceCleanup()
        this.transition('idle')
        throw error
      } finally {
        this.activeOperation = null
      }
    }

    const op = run()
    this.activeOperation = op.then(() => undefined, () => undefined)
    return op
  }

  async cancel(): Promise<void> {
    if (this.phase === 'starting' && this.activeOperation) {
      await this.activeOperation.catch(() => {})
    }
    if (this.phase === 'canceling') return
    if (!this.recording && this.phase === 'idle') return

    const run = async () => {
      this.transition('canceling')
      try {
        await this.forceCleanup()
      } catch {
      } finally {
        this.transition('idle')
        this.activeOperation = null
      }
    }

    this.activeOperation = run()
    return this.activeOperation
  }

  async forceCleanup(): Promise<void> {
    if (!this.recording) {
      await this.resetAudioMode()
      return
    }

    const current = this.recording
    this.recording = null
    this.recordingStartedAt = null
    this.didObserveRecordingStart = false
    try {
      await this.safeStopAndUnload(current)
    } catch {
    } finally {
      await this.resetAudioMode()
    }
  }

  private async resetAudioMode() {
    try {
      await Audio.setAudioModeAsync(this.getAudioModeOptions(false))
    } catch {
    }
  }

  private transition(next: RecorderPhase) {
    this.phase = next
  }
}
