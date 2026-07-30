import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCallRecords } from './callHistory';
import type { CallRecord } from '../types';

function rec(partial: Partial<CallRecord> & { id: string; startedAt: string }): CallRecord {
  return {
    direction: 'inbound',
    fromNumber: '8455551212',
    toNumber: '101',
    durationSec: 0,
    ...partial,
  } as CallRecord;
}

describe('mergeCallRecords — answered_elsewhere', () => {
  it('promotes a matching server record from missed to answered_elsewhere', () => {
    const base = '2026-06-10T12:00:00.000Z';
    const remote = [rec({ id: 'srv1', startedAt: base, disposition: 'missed' })];
    const local = [
      rec({ id: 'invite:abc', startedAt: '2026-06-10T12:00:10.000Z', disposition: 'answered_elsewhere' }),
    ];
    const merged = mergeCallRecords(remote, local);
    // The remote record wins on identity but takes the answered_elsewhere label.
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'srv1');
    assert.equal(merged[0].disposition, 'answered_elsewhere');
  });

  it('keeps the local answered_elsewhere record when there is no server match', () => {
    const remote: CallRecord[] = [];
    const local = [
      rec({ id: 'invite:abc', startedAt: '2026-06-10T12:00:00.000Z', disposition: 'answered_elsewhere' }),
    ];
    const merged = mergeCallRecords(remote, local);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].disposition, 'answered_elsewhere');
  });

  it('does not alter unrelated remote records', () => {
    const remote = [
      rec({ id: 'srv1', startedAt: '2026-06-10T10:00:00.000Z', disposition: 'answered' }),
      rec({ id: 'srv2', startedAt: '2026-06-10T12:00:00.000Z', disposition: 'missed' }),
    ];
    const local = [
      rec({ id: 'invite:abc', startedAt: '2026-06-10T12:00:05.000Z', disposition: 'answered_elsewhere' }),
    ];
    const merged = mergeCallRecords(remote, local);
    const srv1 = merged.find((m) => m.id === 'srv1');
    const srv2 = merged.find((m) => m.id === 'srv2');
    assert.equal(srv1?.disposition, 'answered'); // untouched
    assert.equal(srv2?.disposition, 'answered_elsewhere'); // promoted
  });
});

describe('mergeCallRecords — ring_ended_unanswered promotion (2026-07-29 hardening)', () => {
  const base = '2026-06-10T12:00:00.000Z';

  it('server answered + local unanswered-ring trace → answered_elsewhere', () => {
    const remote = [rec({ id: 'srv1', startedAt: base, disposition: 'answered', durationSec: 84 })];
    const local = [
      rec({ id: 'invite:abc', startedAt: '2026-06-10T12:00:07.000Z', disposition: 'ring_ended_unanswered' }),
    ];
    const merged = mergeCallRecords(remote, local);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'srv1');
    assert.equal(merged[0].disposition, 'answered_elsewhere');
  });

  it('server missed + local unanswered-ring trace → stays missed (caller hangup / voicemail)', () => {
    const remote = [rec({ id: 'srv1', startedAt: base, disposition: 'missed' })];
    const local = [
      rec({ id: 'invite:abc', startedAt: '2026-06-10T12:00:07.000Z', disposition: 'ring_ended_unanswered' }),
    ];
    const merged = mergeCallRecords(remote, local);
    assert.equal(merged[0].disposition, 'missed');
  });

  it('this device answered too → stays answered (never mislabel own answers)', () => {
    const remote = [rec({ id: 'srv1', startedAt: base, disposition: 'answered', durationSec: 30 })];
    const local = [
      rec({ id: 'invite:abc', startedAt: '2026-06-10T12:00:03.000Z', disposition: 'ring_ended_unanswered' }),
      rec({ id: 'call:xyz', startedAt: '2026-06-10T12:00:06.000Z', disposition: 'answered', durationSec: 30 }),
    ];
    const merged = mergeCallRecords(remote, local);
    assert.equal(merged[0].disposition, 'answered');
  });

  it('no local trace at all → server verdict untouched', () => {
    const remote = [rec({ id: 'srv1', startedAt: base, disposition: 'answered', durationSec: 84 })];
    const merged = mergeCallRecords(remote, []);
    assert.equal(merged[0].disposition, 'answered');
  });
});
