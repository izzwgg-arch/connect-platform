package com.connectcommunications.mobile

import android.content.ComponentName
import android.content.pm.PackageManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Flips which launcher activity-alias is enabled so the HOME-SCREEN ICON
 * follows the in-app theme (Izzy 2026-08-22: light mode = Blue 2B, dark mode
 * = Navy 2A). The two aliases live in AndroidManifest.xml (.LauncherBlue
 * enabled by default, .LauncherNavy disabled) and both target .MainActivity.
 *
 * ⛔ Rules this module must keep:
 *  - NEVER touch .MainActivity's own enabled state — notifications and deep
 *    links start it by explicit class, and a disabled activity cannot start.
 *  - Enable the NEW alias BEFORE disabling the old one, so there is never a
 *    moment with zero launcher entries (some launchers treat that as an
 *    uninstall and drop the icon permanently).
 *  - Always DONT_KILL_APP — the user just toggled a setting; killing the app
 *    (and its SIP engine) over an icon would be absurd.
 *  - Skip the write when the state already matches: setComponentEnabledSetting
 *    broadcasts a package change every time, and launchers redraw on it.
 */
class LauncherIconModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "LauncherIcon"

  private fun component(alias: String): ComponentName =
    ComponentName(reactContext.packageName, "${reactContext.packageName}.$alias")

  private fun isEnabled(alias: String, enabledByDefault: Boolean): Boolean {
    return when (reactContext.packageManager.getComponentEnabledSetting(component(alias))) {
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED -> false
      // DEFAULT = whatever the manifest says.
      else -> enabledByDefault
    }
  }

  /** variant: "blue" (light theme) | "navy" (dark theme). */
  @ReactMethod
  fun set(variant: String, promise: Promise) {
    try {
      val wantNavy = variant == "navy"
      val pm = reactContext.packageManager
      val navyOn = isEnabled("LauncherNavy", false)
      val blueOn = isEnabled("LauncherBlue", true)
      if (wantNavy == navyOn && wantNavy != blueOn) {
        promise.resolve("unchanged")
        return
      }
      val enable = if (wantNavy) "LauncherNavy" else "LauncherBlue"
      val disable = if (wantNavy) "LauncherBlue" else "LauncherNavy"
      pm.setComponentEnabledSetting(
        component(enable),
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
        PackageManager.DONT_KILL_APP,
      )
      pm.setComponentEnabledSetting(
        component(disable),
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.DONT_KILL_APP,
      )
      promise.resolve("set")
    } catch (e: Exception) {
      promise.reject("launcher_icon_failed", e)
    }
  }

  @ReactMethod
  fun get(promise: Promise) {
    try {
      promise.resolve(if (isEnabled("LauncherNavy", false)) "navy" else "blue")
    } catch (e: Exception) {
      promise.reject("launcher_icon_failed", e)
    }
  }
}
