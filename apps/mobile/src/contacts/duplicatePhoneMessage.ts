/**
 * Message shown when a contact can't be saved because another contact already
 * holds the phone number.
 *
 * Why this exists (2026-08-02): Eli could not save a contact for over a month.
 * He had imported his whole phone book (1,247 contacts), the app could only
 * show and search the first 1,000, and he kept re-adding people sitting in the
 * invisible tail. Every attempt returned "A contact with this phone number
 * already exists" — accurate, but naming nobody, so there was nothing to act
 * on and it read as "saving is broken". 16 saves attempted, 16 refused, 0
 * contacts created. Naming the contact turns a dead end into an answer.
 *
 * Lives in its own module so both the Contacts-tab sheet and the shared
 * add-contact sheet can use it without importing a screen into a component.
 */
export function duplicatePhoneMessage(existingContactName?: string | null): string {
  const name = (existingContactName || '').trim();
  return name
    ? `This number is already saved under "${name}". Search for that name to open it, or use a different number.`
    : 'A contact with this phone number already exists.';
}
