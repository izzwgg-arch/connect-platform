/**
 * Phone contacts import — reads the device address book (with the user's
 * explicit permission) and uploads selected entries into the Connect
 * tenant contact directory.
 *
 * Design notes
 * ────────────
 * • Permission is requested at the moment the user taps "Import from
 *   phone" — never at startup, never in the background. Denial shows a
 *   friendly message with a button to open Settings.
 * • Phone numbers are normalised to digit-only (with optional leading +)
 *   strings. Two contacts collide if any normalised number matches.
 * • The server's `POST /contacts/import` endpoint is currently a stub
 *   (`501 import_not_implemented`), so we fall back to repeated
 *   `POST /contacts` calls — exactly what the existing "Add contact"
 *   modal already uses. Each call is wrapped in try/catch so a
 *   server-side `409 duplicate_phone` becomes a "merged/skipped" entry
 *   rather than a hard failure.
 * • All requests stay scoped to the user's tenant via the existing JWT
 *   auth — the server resolves tenantId from the token.
 */
import * as Contacts from 'expo-contacts';
import { Linking, Platform } from 'react-native';
import { createContact, getContacts, type CreateContactInput } from '../api/client';
import type { Contact, ContactPhone } from '../types';

const log = (tag: string, payload?: unknown) => {
  if (payload === undefined) console.log(`[contacts_import] ${tag}`);
  else {
    try { console.log(`[contacts_import] ${tag}`, payload); }
    catch { console.log(`[contacts_import] ${tag}`); }
  }
};

export type PhoneContactPhone = {
  numberRaw: string;
  numberNormalized: string;
  type: 'mobile' | 'home' | 'office' | 'other';
  isPrimary: boolean;
};

export type PhoneContactCandidate = {
  /** Stable id derived from the OS contact id. */
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  company: string;
  phones: PhoneContactPhone[];
  emails: Array<{ email: string; type: 'work' | 'personal' | 'other'; isPrimary: boolean }>;
  /** True if the candidate matches an existing Connect contact (any phone). */
  alreadyExists: boolean;
  /** Reason for being skipped, if any. */
  skipReason?: 'no_phone' | 'system';
};

export type ImportPreview = {
  totalFound: number;
  candidates: PhoneContactCandidate[];
  newCount: number;
  alreadyExistsCount: number;
  skippedNoPhoneCount: number;
};

export type ImportResult = {
  imported: number;
  /** Skipped because they already existed in the Connect directory. */
  duplicatesMerged: number;
  /** Skipped because they had no phone numbers. */
  skippedNoPhone: number;
  /** Total failures (network, validation, etc). */
  failures: number;
  failureMessages: string[];
};

export type PermissionState =
  | { status: 'granted' }
  | { status: 'denied'; canAskAgain: boolean }
  | { status: 'undetermined' };

// ── Permission helpers ──────────────────────────────────────────────────

export async function checkContactsPermission(): Promise<PermissionState> {
  try {
    const res = await Contacts.getPermissionsAsync();
    if (res.status === 'granted') return { status: 'granted' };
    if (res.status === 'denied') {
      return { status: 'denied', canAskAgain: res.canAskAgain ?? true };
    }
    return { status: 'undetermined' };
  } catch (err) {
    log('permission_check_error', { err: String((err as any)?.message ?? err) });
    return { status: 'undetermined' };
  }
}

export async function requestContactsPermission(): Promise<PermissionState> {
  try {
    const res = await Contacts.requestPermissionsAsync();
    const priv = (res as { accessPrivileges?: string }).accessPrivileges;
    log('permission_requested', { status: res.status, canAskAgain: res.canAskAgain, accessPrivileges: priv });
    if (res.status === 'granted') return { status: 'granted' };
    if (res.status === 'denied') {
      return { status: 'denied', canAskAgain: res.canAskAgain ?? false };
    }
    return { status: 'undetermined' };
  } catch (err) {
    log('permission_request_error', { err: String((err as any)?.message ?? err) });
    return { status: 'denied', canAskAgain: false };
  }
}

export function openAppSettings(): Promise<void> {
  if (Platform.OS === 'ios') {
    return Linking.openURL('app-settings:').catch(() => undefined as any);
  }
  return Linking.openSettings().catch(() => undefined as any);
}

// ── Normalisation / dedup ────────────────────────────────────────────────

/**
 * Normalise a phone number to digit-only form (optionally retaining a
 * leading '+'). This matches the server's normalizeContactPhone() rules
 * closely enough for client-side dedup; the server still does its own
 * normalisation when storing.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits ? (hasPlus ? `+${digits}` : digits) : '';
}

function osTypeToConnectType(t?: string | null): PhoneContactPhone['type'] {
  const lower = String(t || '').toLowerCase();
  if (lower.includes('mobile') || lower.includes('cell') || lower.includes('iphone')) return 'mobile';
  if (lower.includes('work') || lower.includes('office')) return 'office';
  if (lower.includes('home')) return 'home';
  return 'other';
}

function osEmailTypeToConnectType(t?: string | null): 'work' | 'personal' | 'other' {
  const lower = String(t || '').toLowerCase();
  if (lower.includes('work')) return 'work';
  if (lower.includes('home') || lower.includes('personal')) return 'personal';
  return 'other';
}

function buildDisplayName(c: Contacts.Contact): string {
  const explicit = String(c.name || '').trim();
  if (explicit) return explicit;
  const parts = [c.firstName, c.middleName, c.lastName]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  return parts.join(' ') || String(c.company || '').trim() || '';
}

// ── Preview ─────────────────────────────────────────────────────────────

/**
 * Read every contact from the OS and merge with the existing Connect
 * contact directory to produce a preview. Throws if the user has not
 * granted permission yet — caller is expected to request permission first.
 */
export async function buildImportPreview(authToken: string): Promise<ImportPreview> {
  const perm = await checkContactsPermission();
  if (perm.status !== 'granted') {
    throw new Error('contacts_permission_not_granted');
  }

  // Pull the device address book. Pagination is unnecessary here — even
  // very large books (~3000) round-trip fast through the bridge because
  // we only request the fields we need.
  let payload: Awaited<ReturnType<typeof Contacts.getContactsAsync>>;
  try {
    payload = await Contacts.getContactsAsync({
      fields: [
        Contacts.Fields.ID,
        Contacts.Fields.Name,
        Contacts.Fields.FirstName,
        Contacts.Fields.LastName,
        Contacts.Fields.Company,
        Contacts.Fields.PhoneNumbers,
        Contacts.Fields.Emails,
      ],
    });
  } catch (err) {
    const m = String((err as any)?.message ?? err);
    log('getContactsAsync_failed', { err: m });
    throw new Error(`contacts_read_failed:${m}`);
  }
  const osContacts = Array.isArray(payload?.data) ? payload.data : [];
  log('os_contacts_loaded', { total: osContacts.length });

  // Pull the existing Connect contacts so we can flag duplicates.
  let existingNumbers = new Set<string>();
  try {
    const directory = await getContacts(authToken, '');
    for (const row of directory.rows) {
      for (const phone of row.phones || []) {
        const norm = normalizePhone((phone as ContactPhone).numberRaw);
        if (norm) existingNumbers.add(norm);
      }
    }
    log('existing_directory_loaded', { totalContacts: directory.rows.length, totalNumbers: existingNumbers.size });
  } catch (err) {
    log('existing_directory_load_failed', { err: String((err as any)?.message ?? err) });
    existingNumbers = new Set();
  }

  // Internal: dedup phone numbers WITHIN a single OS contact (Android
  // sometimes lists the same number twice with different labels).
  const candidates: PhoneContactCandidate[] = [];
  let alreadyExistsCount = 0;
  let skippedNoPhoneCount = 0;

  for (const c of osContacts) {
    const displayName = buildDisplayName(c);
    const rawPhones = Array.isArray(c.phoneNumbers) ? c.phoneNumbers : [];
    const seen = new Set<string>();
    const phones: PhoneContactPhone[] = [];
    for (let i = 0; i < rawPhones.length; i++) {
      const raw = rawPhones[i];
      const number = String(raw.number || '').trim();
      const norm = normalizePhone(number);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      phones.push({
        numberRaw: number,
        numberNormalized: norm,
        type: osTypeToConnectType(raw.label),
        isPrimary: phones.length === 0,
      });
    }

    if (phones.length === 0) {
      skippedNoPhoneCount++;
      candidates.push({
        id: `os:${c.id ?? Math.random().toString(36).slice(2)}`,
        displayName: displayName || 'Unnamed contact',
        firstName: String(c.firstName || '').trim(),
        lastName: String(c.lastName || '').trim(),
        company: String(c.company || '').trim(),
        phones: [],
        emails: [],
        alreadyExists: false,
        skipReason: 'no_phone',
      });
      continue;
    }

    const rawEmails = Array.isArray(c.emails) ? c.emails : [];
    const emails = rawEmails
      .map((e, idx) => ({
        email: String(e.email || '').trim(),
        type: osEmailTypeToConnectType(e.label),
        isPrimary: idx === 0,
      }))
      .filter((e) => e.email.length > 0 && /.+@.+\..+/.test(e.email));

    const matched = phones.some((p) => existingNumbers.has(p.numberNormalized));
    if (matched) alreadyExistsCount++;

    candidates.push({
      id: `os:${c.id ?? Math.random().toString(36).slice(2)}`,
      displayName: displayName || phones[0].numberRaw,
      firstName: String(c.firstName || '').trim(),
      lastName: String(c.lastName || '').trim(),
      company: String(c.company || '').trim(),
      phones,
      emails,
      alreadyExists: matched,
    });
  }

  // Stable sort: existing first (so user can see what's "already merged"),
  // then importable, alphabetical within each group.
  candidates.sort((a, b) => {
    if (a.skipReason && !b.skipReason) return 1;
    if (!a.skipReason && b.skipReason) return -1;
    if (a.alreadyExists !== b.alreadyExists) return a.alreadyExists ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  const newCount = candidates.filter((c) => !c.alreadyExists && !c.skipReason).length;
  return {
    totalFound: osContacts.length,
    candidates,
    newCount,
    alreadyExistsCount,
    skippedNoPhoneCount,
  };
}

// ── Import ──────────────────────────────────────────────────────────────

export type ImportProgressCallback = (progress: { done: number; total: number; currentName: string }) => void;

/** Parallel uploads — avoids one hung POST blocking all progress updates. */
const IMPORT_UPLOAD_CONCURRENCY = 4;

/**
 * Import the given candidates into Connect. Each candidate becomes one
 * `POST /contacts` call. The server enforces tenant isolation via the
 * JWT, and rejects duplicate phones with `409 duplicate_phone` — we
 * count those as "duplicates merged" so the user sees a clean summary
 * instead of a wall of errors.
 *
 * Progress: `completed` increments only after each contact is fully
 * processed (so the UI does not sit at "0" while the first slow network
 * round-trip is in flight). A small pool runs uploads in parallel.
 */
export async function importContacts(
  authToken: string,
  candidates: PhoneContactCandidate[],
  onProgress?: ImportProgressCallback,
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    duplicatesMerged: 0,
    skippedNoPhone: 0,
    failures: 0,
    failureMessages: [],
  };

  const total = candidates.length;
  let completed = 0;

  const bumpProgress = (currentName: string) => {
    onProgress?.({ done: completed, total, currentName });
  };

  bumpProgress('Starting import…');

  const queue = candidates.slice();

  const processOne = async (c: PhoneContactCandidate): Promise<void> => {
    if (c.skipReason === 'no_phone' || c.phones.length === 0) {
      result.skippedNoPhone++;
      return;
    }

    const input: CreateContactInput = {
      firstName: c.firstName || undefined,
      lastName: c.lastName || undefined,
      displayName: c.displayName || undefined,
      company: c.company || undefined,
      phones: c.phones.map((p) => ({ type: p.type, numberRaw: p.numberRaw, isPrimary: p.isPrimary })),
      emails: c.emails.map((e) => ({ type: e.type, email: e.email, isPrimary: e.isPrimary })),
    };

    try {
      await createContact(authToken, input);
      result.imported++;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('duplicate_phone')) {
        result.duplicatesMerged++;
      } else {
        result.failures++;
        let detail = msg;
        if (msg === 'forbidden' || msg.includes('forbidden')) {
          detail =
            'Your account cannot add contacts. Ask a tenant admin to grant contact-management access, or try again as a different role.';
        } else if (msg.includes('CONTACT_CREATE_TIMEOUT')) {
          detail = 'Network timed out while saving this contact. Check your connection and try again.';
        }
        if (result.failureMessages.length < 8) {
          result.failureMessages.push(`${c.displayName}: ${detail}`);
        }
        log('import_failed', { name: c.displayName, err: msg });
      }
    }
  };

  async function worker(): Promise<void> {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      await processOne(c);
      completed++;
      log('import_contact_done', { completed, total, name: c.displayName });
      bumpProgress(c.displayName);
    }
  }

  const pool = Math.max(1, Math.min(IMPORT_UPLOAD_CONCURRENCY, candidates.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));

  log('import_complete', result);
  return result;
}
