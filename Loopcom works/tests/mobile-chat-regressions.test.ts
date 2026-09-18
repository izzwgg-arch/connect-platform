import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSendDraftSnapshot,
  computeWaveformPlaybackFrame,
  toInvertedThreadItems,
} from '../apps/mobile/src/screens/messages/message-thread-utils'

test('voice note dot stays on filled-bars boundary', () => {
  const frame = computeWaveformPlaybackFrame({
    positionMs: 2500,
    durationMs: 10_000,
    barsCount: 48,
    waveformWidth: 240,
  })

  assert.equal(frame.activeBars, 12)
  assert.equal(frame.dotX, (frame.activeBars / 48) * 240)
})

test('voice note boundary has no drift across full playback', () => {
  const barsCount = 48
  const width = 300
  const durationMs = 30_000

  for (let positionMs = 0; positionMs <= durationMs; positionMs += 73) {
    const frame = computeWaveformPlaybackFrame({
      positionMs,
      durationMs,
      barsCount,
      waveformWidth: width,
    })
    assert.equal(frame.dotX, (frame.activeBars / barsCount) * width)
  }
})

test('chat thread items are inverted so screen opens at latest side', () => {
  const chronological = Array.from({ length: 120 }, (_, index) => ({ id: `m-${index + 1}` }))
  const inverted = toInvertedThreadItems(chronological)

  assert.equal(inverted[0]?.id, 'm-120')
  assert.equal(inverted[inverted.length - 1]?.id, 'm-1')
  assert.equal(inverted.length, 120)
})

test('send snapshot preserves outgoing text but clears composer immediately', () => {
  const snapshot = buildSendDraftSnapshot({
    text: 'hello team',
    mediaDrafts: [{ kind: 'IMAGE', localUri: 'file://pic.jpg' }],
    replyTo: null,
  })

  assert.equal(snapshot.outgoingText, 'hello team')
  assert.equal(snapshot.trimmedText, 'hello team')
  assert.equal(snapshot.nextText, '')
  assert.equal(snapshot.outgoingDrafts.length, 1)
})
