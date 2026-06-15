/**
 * Mirror a newly-created Connect contact into the device address book so it
 * backs up & syncs through the user's Google (Android) or iCloud (iOS) account
 * — the same end result as adding a contact in WhatsApp.
 *
 * Android: a custom native module (`DeviceContacts`) inserts the raw contact
 * under the primary *syncable* account. We can't use expo-contacts here because
 * it writes contacts with a null account, which Android treats as a phone-only
 * entry that Google never backs up. See DeviceContactsModule.kt.
 *
 * iOS: expo-contacts' `addContactAsync` writes to the default container
 * (iCloud/local), which already backs up — no native module needed.
 *
 * Everything here is BEST-EFFORT: the Connect contact is already saved on the
 * server by the time we run, so a failure to mirror to the device (permission
 * denied, no account, etc.) must never surface as an error or block the UI.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import * as Contacts from 'expo-contacts';

export type DeviceContactInput = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  company?: string;
  phones?: Array<{ numberRaw: string; type?: string }>;
  emails?: Array<{ email: string; type?: string }>;
};

const log = (tag: string, payload?: unknown) => {
  try {
    if (payload === undefined) console.log(`[device_contacts] ${tag}`);
    else console.log(`[device_contacts] ${tag}`, payload);
  } catch {
    console.log(`[device_contacts] ${tag}`);
  }
};

/**
 * Ensure we hold *write* permission. On Android WRITE_CONTACTS is a distinct
 * runtime permission, so we request it explicitly (not via expo-contacts, which
 * only manages READ). On iOS a single Contacts permission covers read+write.
 */
async function ensurePermission(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      const perm = PermissionsAndroid.PERMISSIONS.WRITE_CONTACTS;
      if (await PermissionsAndroid.check(perm)) return true;
      const res = await PermissionsAndroid.request(perm);
      return res === PermissionsAndroid.RESULTS.GRANTED;
    }
    const current = await Contacts.getPermissionsAsync();
    if (current.status === 'granted') return true;
    if (current.status === 'denied' && current.canAskAgain === false) return false;
    const res = await Contacts.requestPermissionsAsync();
    return res.status === 'granted';
  } catch (err) {
    log('permission_error', { err: String((err as any)?.message ?? err) });
    return false;
  }
}

async function saveAndroid(input: DeviceContactInput): Promise<void> {
  const mod = (NativeModules as any)?.DeviceContacts;
  if (!mod?.addContact) {
    log('native_module_missing');
    return;
  }
  const payload = {
    displayName: input.displayName ?? '',
    firstName: input.firstName ?? '',
    lastName: input.lastName ?? '',
    company: input.company ?? '',
    phones: (input.phones ?? [])
      .filter((p) => p.numberRaw?.trim())
      .map((p) => ({ number: p.numberRaw.trim(), label: p.type ?? 'mobile' })),
    emails: (input.emails ?? [])
      .filter((e) => e.email?.trim())
      .map((e) => ({ address: e.email.trim(), label: e.type ?? 'work' })),
  };
  const res = await mod.addContact(payload);
  log('android_saved', res);
}

async function saveIos(input: DeviceContactInput): Promise<void> {
  const contact: Contacts.Contact = {
    contactType: Contacts.ContactTypes.Person,
    [Contacts.Fields.FirstName]: input.firstName || undefined,
    [Contacts.Fields.LastName]: input.lastName || undefined,
    [Contacts.Fields.Company]: input.company || undefined,
    name: input.displayName || `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim(),
    [Contacts.Fields.PhoneNumbers]: (input.phones ?? [])
      .filter((p) => p.numberRaw?.trim())
      .map((p) => ({ label: p.type ?? 'mobile', number: p.numberRaw.trim() })),
    [Contacts.Fields.Emails]: (input.emails ?? [])
      .filter((e) => e.email?.trim())
      .map((e) => ({ label: e.type ?? 'work', email: e.email.trim() })),
  } as Contacts.Contact;
  const id = await Contacts.addContactAsync(contact);
  log('ios_saved', { id });
}

/**
 * Fire-and-forget mirror of a Connect contact into the device address book.
 * Never throws; logs and returns on any failure.
 */
export async function saveContactToDevice(input: DeviceContactInput): Promise<void> {
  try {
    const hasAnything =
      (input.displayName?.trim() || input.firstName?.trim() || input.lastName?.trim()) &&
      ((input.phones?.some((p) => p.numberRaw?.trim()) ?? false) ||
        (input.emails?.some((e) => e.email?.trim()) ?? false));
    if (!hasAnything) return;

    const granted = await ensurePermission();
    if (!granted) {
      log('permission_not_granted');
      return;
    }

    if (Platform.OS === 'android') await saveAndroid(input);
    else if (Platform.OS === 'ios') await saveIos(input);
  } catch (err) {
    log('save_failed', { err: String((err as any)?.message ?? err) });
  }
}
