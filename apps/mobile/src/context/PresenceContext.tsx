import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getDnd, hydrateDnd, setDnd, subscribeDnd } from '../sip/dndStore';

export type PresenceStatus = 'available' | 'busy' | 'dnd' | 'away' | 'offline';

type PresenceContextValue = {
  myStatus: PresenceStatus;
  setMyStatus: (status: PresenceStatus) => void;
  statusLabel: (status: PresenceStatus) => string;
  isDnd: boolean;
};

const PresenceContext = createContext<PresenceContextValue | undefined>(undefined);

const LABELS: Record<PresenceStatus, string> = {
  available: 'Available',
  busy: 'Busy',
  dnd: 'Do Not Disturb',
  away: 'Away',
  offline: 'Invisible',
};

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const [myStatus, setMyStatusState] = useState<PresenceStatus>(() =>
    getDnd() ? 'dnd' : 'available'
  );

  // Hydrate persisted DND on mount and keep the UI in sync if the SIP layer (or
  // another surface) flips DND. The store is the single source of truth that the
  // non-React SIP `newRTCSession` handler reads to decline calls with 486.
  useEffect(() => {
    let active = true;
    hydrateDnd()
      .then((dnd) => {
        if (active) setMyStatusState((prev) => (dnd ? 'dnd' : prev === 'dnd' ? 'available' : prev));
      })
      .catch(() => {});
    const unsub = subscribeDnd((dnd) => {
      setMyStatusState((prev) => {
        if (dnd) return 'dnd';
        return prev === 'dnd' ? 'available' : prev;
      });
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  // Wrap setMyStatus so toggling presence also drives the shared DND store.
  const setMyStatus = useMemo(
    () =>
      (status: PresenceStatus) => {
        setMyStatusState(status);
        setDnd(status === 'dnd');
      },
    []
  );

  const value = useMemo<PresenceContextValue>(
    () => ({
      myStatus,
      setMyStatus,
      statusLabel: (s) => LABELS[s] ?? s,
      isDnd: myStatus === 'dnd',
    }),
    [myStatus, setMyStatus]
  );

  return (
    <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>
  );
}

export function usePresence() {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error('usePresence must be inside PresenceProvider');
  return ctx;
}
