import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCallReturnTab, isTabRoute, recordFocusedRoute } from './callOrigin';

describe('callOrigin', () => {
  it('defaults to Keypad before any tab is seen', () => {
    // Fresh module would be Keypad; we cannot reset module state here, so we
    // assert the fallback by recording an unknown route (no-op) first.
    recordFocusedRoute('ActiveCall');
    assert.equal(getCallReturnTab(), 'Keypad');
  });

  it('remembers the last visited tab', () => {
    recordFocusedRoute('Recent');
    assert.equal(getCallReturnTab(), 'Recent');
    recordFocusedRoute('Chat');
    assert.equal(getCallReturnTab(), 'Chat');
  });

  it('ignores non-tab routes so the call modal does not overwrite origin', () => {
    recordFocusedRoute('Contact');
    recordFocusedRoute('ActiveCall'); // ignored
    recordFocusedRoute('IncomingCall'); // ignored
    assert.equal(getCallReturnTab(), 'Contact');
  });

  it('isTabRoute only accepts known tabs', () => {
    assert.equal(isTabRoute('Keypad'), true);
    assert.equal(isTabRoute('Recent'), true);
    assert.equal(isTabRoute('ActiveCall'), false);
    assert.equal(isTabRoute(null), false);
    assert.equal(isTabRoute(undefined), false);
  });
});
