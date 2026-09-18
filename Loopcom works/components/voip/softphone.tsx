'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Phone, PhoneOff, PhoneIncoming, PhoneOutgoing } from 'lucide-react'
import { formatPhoneNumber } from '@/lib/utils'

interface SoftphoneProps {
  isActive: boolean
  onCallStart?: (number: string) => void
  onCallEnd?: () => void
}

export function Softphone({ isActive, onCallStart, onCallEnd }: SoftphoneProps) {
  const [phoneNumber, setPhoneNumber] = useState('')
  const [isInCall, setIsInCall] = useState(false)
  const [callDuration, setCallDuration] = useState(0)
  const [incomingCall, setIncomingCall] = useState<{
    from: string
    callId: string
  } | null>(null)

  useEffect(() => {
    // Initialize SIP.js here
    // This is a placeholder - actual implementation would:
    // 1. Initialize SIP.UserAgent
    // 2. Register with SIP server
    // 3. Handle incoming calls
    // 4. Manage call state
  }, [])

  const handleDial = () => {
    if (!phoneNumber) return

    // TODO: Implement SIP call initiation
    // const session = userAgent.invite(phoneNumber, {
    //   sessionDescriptionHandlerOptions: {
    //     constraints: { audio: true, video: false }
    //   }
    // })

    setIsInCall(true)
    setCallDuration(0)
    onCallStart?.(phoneNumber)

    // Start call timer
    const interval = setInterval(() => {
      setCallDuration((prev) => prev + 1)
    }, 1000)

    // Store interval ID for cleanup
    return () => clearInterval(interval)
  }

  const handleHangup = () => {
    // TODO: End SIP call
    setIsInCall(false)
    setCallDuration(0)
    setPhoneNumber('')
    onCallEnd?.()
  }

  const handleAnswer = () => {
    // TODO: Answer incoming call
    if (incomingCall) {
      setIsInCall(true)
      setIncomingCall(null)
    }
  }

  const handleReject = () => {
    // TODO: Reject incoming call
    setIncomingCall(null)
  }

  if (!isActive) {
    return null
  }

  // Incoming call overlay
  if (incomingCall && !isInCall) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <Card className="p-6 max-w-md w-full mx-4">
          <div className="text-center space-y-4">
            <PhoneIncoming className="h-16 w-16 text-green-500 mx-auto animate-pulse" />
            <div>
              <h3 className="text-2xl font-bold">Incoming Call</h3>
              <p className="text-xl text-gray-600 mt-2">
                {formatPhoneNumber(incomingCall.from)}
              </p>
            </div>
            <div className="flex items-center justify-center space-x-4">
              <Button
                onClick={handleReject}
                variant="destructive"
                size="lg"
                className="rounded-full h-16 w-16"
              >
                <PhoneOff className="h-8 w-8" />
              </Button>
              <Button
                onClick={handleAnswer}
                size="lg"
                className="rounded-full h-16 w-16 bg-green-600 hover:bg-green-700"
              >
                <Phone className="h-8 w-8" />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  // Persistent softphone dock
  return (
    <div className="fixed bottom-4 right-4 z-40">
      <Card className="p-4 shadow-2xl">
        {isInCall ? (
          <div className="space-y-3">
            <div className="text-center">
              <p className="text-sm text-gray-500">In Call</p>
              <p className="text-lg font-semibold">{formatPhoneNumber(phoneNumber)}</p>
              <p className="text-xs text-gray-400 mt-1">
                {Math.floor(callDuration / 60)}:{(callDuration % 60).toString().padStart(2, '0')}
              </p>
            </div>
            <Button
              onClick={handleHangup}
              variant="destructive"
              className="w-full"
            >
              <PhoneOff className="mr-2 h-4 w-4" />
              Hang Up
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              type="tel"
              placeholder="Enter number"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleDial()
                }
              }}
              className="w-64"
            />
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, '*', 0, '#'].map((num) => (
                <Button
                  key={num}
                  variant="outline"
                  onClick={() => setPhoneNumber((prev) => prev + num)}
                >
                  {num}
                </Button>
              ))}
            </div>
            <Button
              onClick={handleDial}
              disabled={!phoneNumber}
              className="w-full"
            >
              <PhoneOutgoing className="mr-2 h-4 w-4" />
              Call
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
