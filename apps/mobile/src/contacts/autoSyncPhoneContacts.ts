/**
 * Automatic phone-book → Connect contact sync (Izzy 2026-07-28).
 *
 * "When I add a new contact to my phone, it should sync to the app
 * automatically." Exactly that — and nothing more:
 *
 *  - NEVER prompts for permission. Runs only when contacts permission was
 *    already granted (i.e. the user has used Import from phone at least once
 *    or granted it in settings). No permission → silent no-op.
 *  - First run only BASELINES the existing address book (records ids, imports
 *    nothing) so a 2,000-contact phone book is never mass-imported behind the
 *    user's back. From then on, only contacts ADDED since the baseline sync.
 *  - Skips anything already in the Connect directory (preview dedup) and caps
 *    each run so a bulk phone-side import can't flood the tenant directory.
 *  - Debounced to one attempt per 10 minutes, triggered on app foreground.
 *
 * Connect → phone (writing into the OS address book) is intentionally NOT
 * here — it needs the WRITE_CONTACTS permission prompt and belongs to a
 * follow-up approved by the owner.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildImportPreview,
  checkContactsPermission,
  importContacts,
} from './phoneContactsImport';

const SEEN_IDS_KEY = 'cc_phone_contact_sync_seen_v1';
const LAST_RUN_KEY = 'cc_phone_contact_sync_last_v1';
const DEBOUNCE_MS = 10 * 60 * 1000;
const MAX_AUTO_IMPORT_PER_RUN = 25;

let inFlight = false;

export type AutoSyncOutcome =
  | { ran: false; reason: 'debounced' | 'no_permission' | 'busy' | 'error' }
  | { ran: true; baselined: boolean; imported: number };

export async function autoSyncPhoneContacts(authToken: string): Promise<AutoSyncOutcome> {
  if (inFlight) return { ran: false, reason: 'busy' };
  inFlight = true;
  try {
    const lastRaw = await AsyncStorage.getItem(LAST_RUN_KEY);
    const last = lastRaw ? Number(lastRaw) : 0;
    if (Number.isFinite(last) && Date.now() - last < DEBOUNCE_MS) {
      return { ran: false, reason: 'debounced' };
    }

    const perm = await checkContactsPermission();
    if (perm.status !== 'granted') return { ran: false, reason: 'no_permission' };

    const preview = await buildImportPreview(authToken);
    const allIds = preview.candidates.map((c) => c.id);

    const seenRaw = await AsyncStorage.getItem(SEEN_IDS_KEY);
    await AsyncStorage.setItem(LAST_RUN_KEY, String(Date.now())).catch(() => undefined);

    if (seenRaw == null) {
      // First run: baseline only. Every current contact is marked as seen and
      // nothing is imported — future additions sync automatically.
      await AsyncStorage.setItem(SEEN_IDS_KEY, JSON.stringify(allIds));
      console.log(`[CONTACT_SYNC] baseline recorded (${allIds.length} device contacts, nothing imported)`);
      return { ran: true, baselined: true, imported: 0 };
    }

    let seen: Set<string>;
    try {
      const parsed = JSON.parse(seenRaw);
      seen = new Set<string>(Array.isArray(parsed) ? parsed : []);
    } catch {
      seen = new Set<string>();
    }

    const fresh = preview.candidates.filter(
      (c) => !seen.has(c.id) && !c.alreadyExists && !c.skipReason && c.phones.length > 0,
    );
    const toImport = fresh.slice(0, MAX_AUTO_IMPORT_PER_RUN);

    let imported = 0;
    if (toImport.length > 0) {
      const result = await importContacts(authToken, toImport);
      imported = result.imported;
      console.log(
        `[CONTACT_SYNC] auto-imported ${result.imported}/${toImport.length} new phone contacts` +
          (result.failures ? ` (${result.failures} failed)` : ''),
      );
    }

    // Mark everything currently on the device as seen (including skipped and
    // already-existing entries) so each contact is only considered once.
    await AsyncStorage.setItem(SEEN_IDS_KEY, JSON.stringify(allIds));
    return { ran: true, baselined: false, imported };
  } catch (e) {
    console.log('[CONTACT_SYNC] auto-sync skipped:', e instanceof Error ? e.message : String(e));
    return { ran: false, reason: 'error' };
  } finally {
    inFlight = false;
  }
}
