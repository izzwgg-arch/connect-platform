'use client'

import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Phone, PhoneCall, PhoneOff, Mic, MicOff, PauseCircle, PlayCircle } from 'lucide-react'

type SoftphoneStatus =
  | 'idle'
  | 'connecting'
  | 'registered'
  | 'ringing_in'
  | 'calling_out'
  | 'in_call'
  | 'error'

export type VitalPbxConfig = {
  wssUrl: string
  sipDomain: string
  extension: string
  password: string
  displayName?: string
  outboundCallerId?: string
  iceServersJson?: string
}

function safeParseIceServers(json?: string): RTCIceServer[] | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed as RTCIceServer[]
    return undefined
  } catch {
    return undefined
  }
}

function getUserPart(value: any): string {
  try {
    // sip.js URI has .user
    if (value && typeof value.user === 'string') return value.user
  } catch {}
  return ''
}

function normalizeDialTarget(value: string): string {
  const trimmed = value.trim()
  // For phone numbers, tolerate common formatting characters. For named SIP
  // extensions (for example tenant-prefixed endpoints), preserve the user part.
  if (/^\+?[\d\s().-]+$/.test(trimmed)) {
    return trimmed.replace(/[^\d+]/g, '')
  }
  return trimmed
}

export function VitalPbxSoftphone({
  config,
  canCall,
  onLogCall,
}: {
  config: VitalPbxConfig
  canCall: boolean
  onLogCall?: (payload: {
    direction: 'INBOUND' | 'OUTBOUND'
    status: string
    fromNumber: string
    toNumber: string
    startedAt: Date
    answeredAt?: Date | null
    endedAt?: Date | null
    duration?: number | null
  }) => Promise<void>
}) {
  const audioRef = useRef<HTMLAudioElement>(null)

  const [status, setStatus] = useState<SoftphoneStatus>('idle')
  const [error, setError] = useState<string>('')
  const [dial, setDial] = useState('')
  const [muted, setMuted] = useState(false)
  const [held, setHeld] = useState(false)
  const [incomingOpen, setIncomingOpen] = useState(false)
  const [incomingFrom, setIncomingFrom] = useState('')

  const uaRef = useRef<any>(null)
  const registererRef = useRef<any>(null)
  const sessionRef = useRef<any>(null)
  const callStartRef = useRef<Date | null>(null)
  const callAnswerRef = useRef<Date | null>(null)

  const iceServers = useMemo(() => safeParseIceServers(config.iceServersJson), [config.iceServersJson])

  const attachRemoteAudio = async (session: any) => {
    try {
      const pc = session?.sessionDescriptionHandler?.peerConnection
      if (!pc) return
      const remoteStream = new MediaStream()
      pc.getReceivers().forEach((r: any) => {
        if (r.track) remoteStream.addTrack(r.track)
      })
      if (audioRef.current) {
        audioRef.current.srcObject = remoteStream
        await audioRef.current.play().catch(() => {})
      }
    } catch {
      // ignore
    }
  }

  const endSession = async (why: string) => {
    const sess = sessionRef.current
    sessionRef.current = null
    setMuted(false)
    setHeld(false)
    setIncomingOpen(false)
    setIncomingFrom('')

    const startedAt = callStartRef.current
    const answeredAt = callAnswerRef.current
    const endedAt = new Date()
    callStartRef.current = null
    callAnswerRef.current = null

    if (startedAt && onLogCall) {
      const duration =
        answeredAt ? Math.max(0, Math.floor((endedAt.getTime() - answeredAt.getTime()) / 1000)) : null
      const dir = sess?.direction === 'incoming' ? 'INBOUND' : 'OUTBOUND'
      const from = dir === 'INBOUND' ? incomingFrom : config.extension
      const to = dir === 'INBOUND' ? config.extension : dial
      const callStatus =
        why === 'answered' || answeredAt ? 'ANSWERED' : why === 'failed' ? 'FAILED' : why === 'missed' ? 'MISSED' : 'CANCELLED'
      await onLogCall({
        direction: dir,
        status: callStatus,
        fromNumber: from || '',
        toNumber: to || '',
        startedAt,
        answeredAt: answeredAt || null,
        endedAt,
        duration,
      })
    }

    try {
      if (sess) {
        if (sess.state && sess.state.toString().toLowerCase() === 'terminated') return
        await sess.dispose?.()
      }
    } catch {
      // ignore
    }
  }

  const connect = async () => {
    if (!canCall) {
      setError('You do not have permission to make calls.')
      setStatus('error')
      return
    }
    if (!config.password.trim()) {
      setError('Enter the SIP password before connecting.')
      return
    }

    setError('')
    setStatus('connecting')
    try {
      const sip = await import('sip.js')
      const {
        UserAgent,
        Registerer,
        Inviter,
        Invitation,
        SessionState,
        UserAgentState,
      } = sip as any

      const uri = UserAgent.makeURI(`sip:${config.extension}@${config.sipDomain}`)
      if (!uri) throw new Error('Invalid SIP URI')

      const userAgent = new UserAgent({
        uri,
        authorizationUsername: config.extension,
        authorizationPassword: config.password,
        displayName: config.displayName || 'Trim Pro',
        transportOptions: { server: config.wssUrl },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers: iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }],
          },
        },
      })

      userAgent.delegate = {
        onInvite: (invitation: any) => {
          sessionRef.current = invitation
          invitation.direction = 'incoming'
          callStartRef.current = new Date()
          callAnswerRef.current = null

          const fromUri = invitation?.remoteIdentity?.uri
          const from = getUserPart(fromUri) || 'Unknown'
          setIncomingFrom(from)
          setIncomingOpen(true)
          setStatus('ringing_in')

          invitation.stateChange.addListener((newState: any) => {
            if (newState === SessionState.Established) {
              callAnswerRef.current = new Date()
              setStatus('in_call')
              attachRemoteAudio(invitation)
            }
            if (newState === SessionState.Terminated) {
              // If never answered, it was missed
              endSession(callAnswerRef.current ? 'answered' : 'missed')
              setStatus('registered')
            }
          })
        },
      }

      uaRef.current = userAgent

      userAgent.stateChange.addListener((s: any) => {
        if (s === UserAgentState.Stopped) {
          setStatus('idle')
        }
      })

      await userAgent.start()
      const registerer = new Registerer(userAgent)
      registererRef.current = registerer
      await registerer.register()
      setStatus('registered')

      // keep Inviter class available by attaching to uaRef
      ;(uaRef.current as any).__Inviter = Inviter
      ;(uaRef.current as any).__SessionState = SessionState
    } catch (e: any) {
      setError(e?.message || 'Failed to connect')
      setStatus('error')
    }
  }

  const disconnect = async () => {
    setError('')
    try {
      if (sessionRef.current) {
        await hangup()
      }
      await registererRef.current?.unregister?.()
      await uaRef.current?.stop?.()
    } catch {
      // ignore
    } finally {
      uaRef.current = null
      registererRef.current = null
      setStatus('idle')
    }
  }

  const startCall = async () => {
    if (!uaRef.current) {
      setError('Not connected. Click Connect first.')
      return
    }
    if (status !== 'registered') {
      setError('Wait until the softphone status is registered before calling.')
      return
    }

    const dialTarget = normalizeDialTarget(dial)
    if (!dialTarget) return

    setError('')
    setStatus('calling_out')
    try {
      const ua = uaRef.current
      const Inviter = ua.__Inviter
      const SessionState = ua.__SessionState

      const target = (await import('sip.js') as any).UserAgent.makeURI(`sip:${dialTarget}@${config.sipDomain}`)
      if (!target) throw new Error('Invalid destination')

      const inviter = new Inviter(ua, target, {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
        },
      })
      inviter.direction = 'outgoing'
      sessionRef.current = inviter
      callStartRef.current = new Date()
      callAnswerRef.current = null

      inviter.stateChange.addListener((newState: any) => {
        if (newState === SessionState.Established) {
          callAnswerRef.current = new Date()
          setStatus('in_call')
          attachRemoteAudio(inviter)
        }
        if (newState === SessionState.Terminated) {
          endSession(callAnswerRef.current ? 'answered' : 'failed')
          setStatus('registered')
        }
      })

      await inviter.invite({
        requestDelegate: {
          onReject: (response: any) => {
            const message = response?.message
            const statusCode = message?.statusCode
            const reasonPhrase = message?.reasonPhrase
            setError(
              `Call rejected${statusCode ? ` (${statusCode}${reasonPhrase ? ` ${reasonPhrase}` : ''})` : ''}`
            )
          },
        },
      })
    } catch (e: any) {
      setError(e?.message || 'Call failed')
      setStatus('registered')
    }
  }

  const answer = async () => {
    const invitation = sessionRef.current
    if (!invitation) return
    setError('')
    try {
      await invitation.accept()
      setIncomingOpen(false)
    } catch (e: any) {
      setError(e?.message || 'Failed to answer')
    }
  }

  const reject = async () => {
    const invitation = sessionRef.current
    if (!invitation) return
    setError('')
    try {
      await invitation.reject()
      endSession('missed')
      setStatus('registered')
    } catch (e: any) {
      setError(e?.message || 'Failed to reject')
    } finally {
      setIncomingOpen(false)
    }
  }

  const hangup = async () => {
    const sess = sessionRef.current
    if (!sess) return
    setError('')
    try {
      await sess.bye?.()
      await sess.cancel?.()
      await sess.reject?.()
    } catch {
      // ignore
    } finally {
      await endSession(callAnswerRef.current ? 'answered' : 'cancelled')
      setStatus('registered')
    }
  }

  const toggleMute = async () => {
    const sess = sessionRef.current
    const pc = sess?.sessionDescriptionHandler?.peerConnection
    if (!pc) return
    const senders = pc.getSenders()
    const next = !muted
    senders.forEach((s: any) => {
      if (s.track && s.track.kind === 'audio') {
        s.track.enabled = !next
      }
    })
    setMuted(next)
  }

  const toggleHold = async () => {
    // SIP hold is non-trivial; this is a local hold (mute + stop remote audio) MVP.
    const next = !held
    setHeld(next)
    if (audioRef.current) {
      audioRef.current.muted = next
    }
  }

  useEffect(() => {
    return () => {
      // cleanup on unmount
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canConnect = status === 'idle' || status === 'error'
  const connected = status !== 'idle' && status !== 'error'
  const inCall = status === 'in_call' || status === 'calling_out' || status === 'ringing_in'
  const canStartCall = status === 'registered'

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Phone className="h-4 w-4" />
              Softphone (VitalPBX)
            </span>
            <span className="text-xs text-gray-500">
              Status: <span className="font-mono">{status}</span>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={connect} disabled={!canConnect || !canCall}>
              <PhoneCall className="mr-2 h-4 w-4" />
              Connect
            </Button>
            <Button variant="outline" onClick={disconnect} disabled={!connected}>
              Disconnect
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              value={dial}
              onChange={(e) => setDial(e.target.value)}
              placeholder="Dial number or extension (e.g. 1002 or +15551234567)"
              disabled={!canStartCall || inCall}
            />
            <Button onClick={startCall} disabled={!canStartCall || inCall || !dial.trim() || !canCall}>
              <PhoneCall className="h-4 w-4" />
            </Button>
            <Button variant="destructive" onClick={hangup} disabled={!connected || !inCall}>
              <PhoneOff className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={toggleMute} disabled={!connected || status !== 'in_call'}>
              {muted ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
              {muted ? 'Unmute' : 'Mute'}
            </Button>
            <Button variant="outline" onClick={toggleHold} disabled={!connected || status !== 'in_call'}>
              {held ? <PlayCircle className="mr-2 h-4 w-4" /> : <PauseCircle className="mr-2 h-4 w-4" />}
              {held ? 'Resume' : 'Hold'}
            </Button>
          </div>

          <audio ref={audioRef} autoPlay playsInline />
          <p className="text-xs text-gray-500">
            VitalPBX must expose <span className="font-mono">WSS</span> for SIP over WebSocket and your extension must have WebRTC enabled.
          </p>
        </CardContent>
      </Card>

      <Dialog open={incomingOpen} onOpenChange={setIncomingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Incoming Call</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              From: <span className="font-mono">{incomingFrom || 'Unknown'}</span>
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={reject}>
                Reject
              </Button>
              <Button onClick={answer}>
                Answer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

