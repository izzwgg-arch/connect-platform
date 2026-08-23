import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { getContacts, mobileQueryKeys } from '../api/client';
import { phoneMatchKey } from '../calls/callerIdentity';

/**
 * Resolves a phone number to a saved contact's display name.
 *
 * Shares the same cached contacts query (key + options) that the Contacts and
 * Recent tabs use, so opening a screen that calls this hook reuses already
 * fetched data instead of refetching. Matching collapses national/country-coded
 * forms via `phoneMatchKey`, mirroring the Recent tab's caller-ID resolution.
 *
 * Returns a stable `resolve(number)` callback that yields the contact name, or
 * `null` when the number is not in the user's contacts (or isn't phone-like).
 */
export function useContactNameResolver(): (number: string | null | undefined) => string | null {
  const { token } = useAuth();
  const contactsQuery = useQuery({
    queryKey: mobileQueryKeys.contacts(''),
    enabled: Boolean(token),
    queryFn: () => getContacts(token!, ''),
    staleTime: 3 * 60 * 1000,
    // Long gc: evicting the directory after 20 idle minutes forced a full
    // multi-page re-walk before any name resolved again — worst for the
    // biggest lists (Relax Tires: 5 pages, several MB, on cellular).
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const nameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contactsQuery.data?.rows ?? []) {
      for (const p of c.phones ?? []) {
        // ⛔ Key on BOTH forms. numberRaw is whatever the phone book or the
        // human typed ("+1 (845) 555-1234 ext 12" → 13 digits → no key), while
        // numberNormalized is the server's clean E.164 → always keys. Raw-only
        // matching is why imported contacts never resolved (Relax Tires,
        // 4,168 imported contacts, 2026-08-23).
        for (const key of [phoneMatchKey(p.numberNormalized), phoneMatchKey(p.numberRaw)]) {
          if (key && !map.has(key)) map.set(key, c.displayName);
        }
      }
    }
    return map;
  }, [contactsQuery.data]);

  return useCallback(
    (number: string | null | undefined): string | null => {
      const key = phoneMatchKey(number ?? null);
      if (!key) return null;
      return nameByKey.get(key) ?? null;
    },
    [nameByKey],
  );
}
