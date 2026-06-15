package com.connectcommunications.mobile

import android.content.ContentProviderOperation
import android.content.pm.PackageManager
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap

/**
 * Writes a Connect contact into the device address book so it backs up and
 * syncs through the user's Google account — the same end result as adding a
 * contact in WhatsApp.
 *
 * Why a native module instead of expo-contacts?
 * ─────────────────────────────────────────────
 * expo-contacts' `addContactAsync` inserts the raw contact with a **null**
 * account (ACCOUNT_TYPE/ACCOUNT_NAME = null). Android treats that as a
 * phone-only / "device" contact that Google Contacts does NOT sync or back up.
 * To get the WhatsApp-style "it just shows up in my Google contacts" behaviour
 * we must insert the RawContact under a real, syncable account.
 *
 * Picking the account: rather than enumerate accounts via AccountManager
 * (which needs the extra GET_ACCOUNTS permission), we read the existing
 * RawContacts table (we already hold READ_CONTACTS) and choose the account
 * that currently holds the most contacts — i.e. exactly "the default place
 * where all the contacts of the device are backed up", preferring a
 * `com.google` account when present. Falls back to a local insert only when
 * the device has no syncable account at all.
 */
class DeviceContactsModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "DeviceContacts"

  private data class Account(val name: String, val type: String)

  private fun hasWritePermission(): Boolean =
    ContextCompat.checkSelfPermission(
      reactApplicationContext,
      android.Manifest.permission.WRITE_CONTACTS,
    ) == PackageManager.PERMISSION_GRANTED

  /**
   * Find the account that should receive new contacts: the one already storing
   * the most contacts, preferring Google. Returns null when nothing syncable
   * exists (→ caller inserts a local contact).
   */
  private fun pickBackupAccount(): Account? {
    val counts = HashMap<Account, Int>()
    try {
      reactApplicationContext.contentResolver.query(
        ContactsContract.RawContacts.CONTENT_URI,
        arrayOf(
          ContactsContract.RawContacts.ACCOUNT_NAME,
          ContactsContract.RawContacts.ACCOUNT_TYPE,
        ),
        null,
        null,
        null,
      )?.use { c ->
        val nameIdx = c.getColumnIndex(ContactsContract.RawContacts.ACCOUNT_NAME)
        val typeIdx = c.getColumnIndex(ContactsContract.RawContacts.ACCOUNT_TYPE)
        while (c.moveToNext()) {
          val name = if (nameIdx >= 0) c.getString(nameIdx) else null
          val type = if (typeIdx >= 0) c.getString(typeIdx) else null
          if (name.isNullOrEmpty() || type.isNullOrEmpty()) continue
          val acct = Account(name, type)
          counts[acct] = (counts[acct] ?: 0) + 1
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "pickBackupAccount query failed: ${t.message}")
    }

    if (counts.isEmpty()) return null
    // Prefer the Google account with the most contacts.
    counts.entries
      .filter { it.key.type.equals("com.google", ignoreCase = true) }
      .maxByOrNull { it.value }
      ?.let { return it.key }
    // Otherwise the most-populated syncable account of any type.
    return counts.entries.maxByOrNull { it.value }?.key
  }

  private fun phoneType(label: String?): Int = when (label?.lowercase()) {
    "mobile", "cell" -> Phone.TYPE_MOBILE
    "home" -> Phone.TYPE_HOME
    "office", "work" -> Phone.TYPE_WORK
    else -> Phone.TYPE_OTHER
  }

  private fun emailType(label: String?): Int = when (label?.lowercase()) {
    "work", "office" -> Email.TYPE_WORK
    "home", "personal" -> Email.TYPE_HOME
    else -> Email.TYPE_OTHER
  }

  /**
   * Insert a contact. Payload shape (all optional except at least one of
   * displayName / phones / emails):
   *   {
   *     displayName: String, firstName: String, lastName: String,
   *     company: String,
   *     phones: [{ number: String, label: String }],
   *     emails: [{ address: String, label: String }],
   *   }
   * Resolves `{ saved: true, account: "name|type"|"local" }`.
   */
  @ReactMethod
  fun addContact(payload: ReadableMap, promise: Promise) {
    if (!hasWritePermission()) {
      promise.reject("PERMISSION_DENIED", "WRITE_CONTACTS permission not granted")
      return
    }

    try {
      val firstName = payload.getStringOr("firstName")
      val lastName = payload.getStringOr("lastName")
      val displayName = payload.getStringOr("displayName")
      val company = payload.getStringOr("company")
      val phones = payload.getArrayOr("phones")
      val emails = payload.getArrayOr("emails")

      val account = pickBackupAccount()
      val ops = ArrayList<ContentProviderOperation>()
      val rawIdx = 0

      ops.add(
        ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
          .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, account?.type)
          .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, account?.name)
          .build(),
      )

      val hasName = !firstName.isNullOrEmpty() || !lastName.isNullOrEmpty() || !displayName.isNullOrEmpty()
      if (hasName) {
        val b = ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
          .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
          .withValue(ContactsContract.Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE)
        if (!displayName.isNullOrEmpty()) b.withValue(StructuredName.DISPLAY_NAME, displayName)
        if (!firstName.isNullOrEmpty()) b.withValue(StructuredName.GIVEN_NAME, firstName)
        if (!lastName.isNullOrEmpty()) b.withValue(StructuredName.FAMILY_NAME, lastName)
        ops.add(b.build())
      }

      if (phones != null) {
        for (i in 0 until phones.size()) {
          val row = phones.getMap(i) ?: continue
          val number = row.getStringOr("number") ?: continue
          if (number.isBlank()) continue
          ops.add(
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
              .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
              .withValue(ContactsContract.Data.MIMETYPE, Phone.CONTENT_ITEM_TYPE)
              .withValue(Phone.NUMBER, number)
              .withValue(Phone.TYPE, phoneType(row.getStringOr("label")))
              .build(),
          )
        }
      }

      if (emails != null) {
        for (i in 0 until emails.size()) {
          val row = emails.getMap(i) ?: continue
          val address = row.getStringOr("address") ?: continue
          if (address.isBlank()) continue
          ops.add(
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
              .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
              .withValue(ContactsContract.Data.MIMETYPE, Email.CONTENT_ITEM_TYPE)
              .withValue(Email.ADDRESS, address)
              .withValue(Email.TYPE, emailType(row.getStringOr("label")))
              .build(),
          )
        }
      }

      if (!company.isNullOrEmpty()) {
        ops.add(
          ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
            .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIdx)
            .withValue(ContactsContract.Data.MIMETYPE, Organization.CONTENT_ITEM_TYPE)
            .withValue(Organization.COMPANY, company)
            .withValue(Organization.TYPE, Organization.TYPE_WORK)
            .build(),
        )
      }

      reactApplicationContext.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)

      val result = com.facebook.react.bridge.Arguments.createMap()
      result.putBoolean("saved", true)
      result.putString("account", account?.let { "${it.name}|${it.type}" } ?: "local")
      promise.resolve(result)
    } catch (t: Throwable) {
      Log.w(TAG, "addContact failed: ${t.message}")
      promise.reject("ADD_CONTACT_FAILED", t.message, t)
    }
  }

  companion object {
    private const val TAG = "DeviceContactsModule"
  }
}

private fun ReadableMap.getStringOr(key: String): String? =
  if (hasKey(key) && !isNull(key)) getString(key) else null

private fun ReadableMap.getArrayOr(key: String): ReadableArray? =
  if (hasKey(key) && !isNull(key)) getArray(key) else null
