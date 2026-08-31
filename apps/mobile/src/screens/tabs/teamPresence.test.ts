/**
 * Mobile Team tab presence rules (2026-08-31).
 *
 * The complaint: "when I hang up, mobile Team Directory keeps showing On Call
 * for minutes." Cause: livePresence OR'd the raw Asterisk BLF hint
 * (`inuse`/`busy`/`onhold`) into the on-call decision, and a hint that went
 * stale at hangup is only corrected by the telephony service's 3-MINUTE
 * presence re-sync sweep. Live calls arrive/leave on the same socket
 * instantly — they are the only honest on-call signal (the rule the web
 * Team Directory has always used).
 *
 * Run: pnpm --filter @connect/mobile test:team-presence
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { livePresence } from './teamPresence';
import type { LiveTelephonyState } from '../../api/realtime';
import type { LiveCall, LiveExtensionState, TeamDirectoryMember } from '../../types';

function member(extension = '101'): TeamDirectoryMember {
  return { id: 'm1', name: 'Test Person', extension, email: null, tenantId: 't1', tenantName: 'Tenant', presence: 'offline' } as unknown as TeamDirectoryMember;
}

function call(state: LiveCall['state'], extensions: string[] = ['101']): LiveCall {
  return {
    id: `call-${state}`,
    tenantId: 't1',
    tenantName: 'Tenant',
    direction: 'inbound',
    state,
    from: '8455551234',
    fromName: null,
    to: '101',
    connectedLine: null,
    channels: ['PJSIP/trunk-a'],
    bridgeIds: [],
    extensions,
    startedAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    durationSec: 0,
    billableSec: 0,
  } as LiveCall;
}

function ext(status: string): LiveExtensionState {
  return { extension: '101', hint: '101@x', status, tenantId: 't1', updatedAt: new Date().toISOString() };
}

function live(calls: LiveCall[], extensions: LiveExtensionState[]): LiveTelephonyState {
  return {
    calls: new Map(calls.map((c) => [c.id, c])),
    extensions: new Map(extensions.map((e) => [`${e.tenantId}|${e.extension}`, e])),
  };
}

test("THE BUG: a stale 'inuse' hint with NO live call reads Available, not On Call", () => {
  // The exact post-hangup shape: call.remove already arrived (calls empty),
  // but the BLF hint is still stuck at inuse for up to 3 minutes.
  assert.equal(livePresence(member(), live([], [ext('inuse')])), 'available');
  assert.equal(livePresence(member(), live([], [ext('busy')])), 'available');
  assert.equal(livePresence(member(), live([], [ext('onhold')])), 'available');
  assert.equal(livePresence(member(), live([], [ext('ringing')])), 'available');
});

test('a live up/held call is On Call; ringing/dialing is Ringing — live calls always win', () => {
  assert.equal(livePresence(member(), live([call('up')], [ext('idle')])), 'on_call');
  assert.equal(livePresence(member(), live([call('held')], [ext('idle')])), 'on_call');
  assert.equal(livePresence(member(), live([call('ringing')], [ext('idle')])), 'ringing');
  assert.equal(livePresence(member(), live([call('dialing')], [ext('idle')])), 'ringing');
});

test('idle hint with no call is Available; no hint at all is Offline', () => {
  assert.equal(livePresence(member(), live([], [ext('idle')])), 'available');
  assert.equal(livePresence(member(), live([], [])), 'offline');
  assert.equal(livePresence(member(), live([], [ext('unavailable')])), 'offline');
});

test("someone ELSE's call never lights this member up", () => {
  assert.equal(livePresence(member(), live([call('up', ['102'])], [ext('idle')])), 'available');
});

test('SOURCE GUARD: TeamTab must not re-grow a local presence rule — it imports the shared one', () => {
  const src = readFileSync(join(__dirname, 'TeamTab.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes("from './teamPresence'"), 'TeamTab must import the pure presence module');
  assert.ok(!src.includes('function livePresence'), 'no second livePresence implementation in TeamTab');
});

test('SOURCE GUARD: the realtime socket drops stale-seq upserts and reconnects on foreground', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'api', 'realtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/call\.seq <= last\) break/.test(src), 'stale-seq upserts must be dropped (never resurrect a removed call)');
  assert.ok(src.includes('AppState.addEventListener'), 'foreground reconnect must exist — a dead socket is a frozen presence list');
});
