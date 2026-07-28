package com.connectcommunications.mobile

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream

/**
 * Exposes the device's PUBLIC Downloads collection to JS.
 *
 * expo-file-system can only write inside the app sandbox
 * (files/, cache/) which the system Files app does not show — a
 * "downloaded" voicemail was therefore invisible to the user. On API 29+
 * MediaStore.Downloads lets us contribute files to the shared Downloads
 * folder with no storage permission.
 */
class DownloadsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ConnectDownloads"

  /**
   * Copy a file the app already fetched into its sandbox out to the public
   * Downloads folder. `sourcePath` may be a file:// URI or a plain path.
   * Resolves with the destination URI/path. Duplicate display names are
   * auto-suffixed by MediaStore ("file (1).wav").
   */
  @ReactMethod
  fun saveToDownloads(sourcePath: String, fileName: String, mimeType: String, promise: Promise) {
    try {
      val src = File(sourcePath.removePrefix("file://"))
      if (!src.exists()) {
        promise.reject("ENOENT", "source file does not exist: $sourcePath")
        return
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = reactContext.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, fileName)
          put(MediaStore.Downloads.MIME_TYPE, mimeType)
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val item = resolver.insert(collection, values)
        if (item == null) {
          promise.reject("EINSERT", "MediaStore insert failed")
          return
        }
        resolver.openOutputStream(item).use { out ->
          if (out == null) {
            promise.reject("EOPEN", "openOutputStream failed for $item")
            return
          }
          FileInputStream(src).use { input -> input.copyTo(out) }
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(item, values, null, null)
        promise.resolve(item.toString())
      } else {
        // Legacy (< Android 10): direct write to the public directory.
        @Suppress("DEPRECATION")
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        downloads.mkdirs()
        val dest = File(downloads, fileName)
        src.copyTo(dest, overwrite = true)
        promise.resolve(dest.absolutePath)
      }
    } catch (t: Throwable) {
      promise.reject("EDOWNLOAD", t.message ?: "saveToDownloads failed", t)
    }
  }
}
