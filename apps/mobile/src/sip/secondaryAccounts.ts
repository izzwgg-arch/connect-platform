/**
 * secondaryAccounts.ts
 *
 * Isolated SIP clients for the user's EXTRA SIP accounts (extensions from
 * other tenants — the "second line" feature). Deliberately completely separate
 * from the process-wide primary singleton in `sipClientSingleton.ts`:
 *
 *   • The primary client, its registration, push wake-up machinery, and the
 *     keep-alive gate are NEVER touched by anything in this module.
 *   • A secondary client is created lazily the first time the user dials from
 *     that account, registers on demand, and simply dies with the JS process.
 *     There is no push/wake support for secondary accounts on mobile — inbound
 *     calls on those accounts are the portal WebRTC phone's job; on mobile
 *     they only ring while the app is foregrounded and the client registered.
 *
 * Credentials are fetched from the API per session and held in memory only —
 * nothing about secondary accounts is written to SecureStore.
 */
import { createSipClient } from "./index";
import type { SipClient, SipEvents } from "./types";
import type { ProvisioningBundle } from "../types";

type Entry = { client: SipClient; configuredAt: number };

const clients = new Map<string, Entry>();

/** All live secondary clients (for session-level lookups across lines). */
export function listSecondarySipClients(): SipClient[] {
  return Array.from(clients.values()).map((e) => e.client);
}

export function getSecondarySipClient(accountId: string): SipClient | null {
  return clients.get(accountId)?.client ?? null;
}

/**
 * Ensure the secondary client for `accountId` exists, is configured, and is
 * registered. `fetchBundle` is only invoked when a (re)configure is needed.
 * Resolves with the client once REGISTER succeeds; rejects on timeout so the
 * caller can show a clean "second line not available" error instead of a
 * silently failing call.
 */
export async function ensureSecondarySipRegistered(
  accountId: string,
  fetchBundle: () => Promise<ProvisioningBundle>,
  events: SipEvents,
  timeoutMs = 12_000,
): Promise<SipClient> {
  let entry = clients.get(accountId);
  if (!entry) {
    entry = { client: createSipClient(), configuredAt: 0 };
    clients.set(accountId, entry);
  }
  const client = entry.client;
  // (Re)attach the caller's event handlers every time — SipContext may have
  // remounted since the client was created.
  client.setEvents(events);

  let registered = false;
  try {
    registered = client.isRegistered();
  } catch {
    registered = false;
  }

  if (!registered) {
    const bundle = await fetchBundle();
    client.configure(bundle);
    entry.configuredAt = Date.now();
    await client.register();
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (client.isRegistered()) return client;
    } catch {
      /* keep polling until deadline */
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("SECOND_LINE_REGISTER_TIMEOUT");
}
