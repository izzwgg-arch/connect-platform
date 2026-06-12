import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowIncomingCallCover } from './incomingCallCover';

describe('shouldShowIncomingCallCover', () => {
  it('does not cover on SIP ringing alone (no invite yet)', () => {
    assert.equal(
      shouldShowIncomingCallCover({
        hasIncomingInvite: false,
        answering: false,
        incomingUiPhase: 'idle',
      }),
      false,
    );
  });

  it('covers once the push layer has set an invite', () => {
    assert.equal(
      shouldShowIncomingCallCover({
        hasIncomingInvite: true,
        answering: false,
        incomingUiPhase: 'incoming',
      }),
      true,
    );
  });

  it('covers during answer handoff after invite is cleared', () => {
    assert.equal(
      shouldShowIncomingCallCover({
        hasIncomingInvite: false,
        answering: true,
        incomingUiPhase: 'idle',
      }),
      true,
    );
  });

  it('covers transient ended/failure UI on IncomingCallScreen', () => {
    assert.equal(
      shouldShowIncomingCallCover({
        hasIncomingInvite: false,
        answering: false,
        incomingUiPhase: 'ended',
      }),
      true,
    );
  });
});
