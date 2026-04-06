import React, { createContext, useContext, useMemo, useState } from 'react';

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
  const [myStatus, setMyStatus] = useState<PresenceStatus>('available');

  const value = useMemo<PresenceContextValue>(
    () => ({
      myStatus,
      setMyStatus,
      statusLabel: (s) => LABELS[s] ?? s,
      isDnd: myStatus === 'dnd',
    }),
    [myStatus]
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
