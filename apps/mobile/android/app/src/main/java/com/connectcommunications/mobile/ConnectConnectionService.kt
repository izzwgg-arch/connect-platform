package com.connectcommunications.mobile

import android.net.Uri
import android.os.Build
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * SELF_MANAGED ConnectionService. The Android Telecom framework starts this
 * service automatically when {@link TelecomManager#addNewIncomingCall} is
 * called from anywhere in the app — including a freshly-spawned
 * FirebaseMessagingService process whose JS engine has not booted yet.
 *
 * The OS owns the incoming-call UI from this point on (system ringer,
 * lock-screen wake, headset routing, "do not disturb" call exception). When
 * the user taps Answer or Decline the corresponding callback fires on the
 * Connection returned below; that Connection forwards the event to JS.
 *
 * SELF_MANAGED is mandatory for VoIP / over-the-top apps that do not want
 * their calls to appear in the native dialer's call log or interfere with
 * cellular calls. It also bypasses the "managed" PhoneAccount enrollment
 * flow that requires the user to pick our app as their default dialer.
 */
class ConnectConnectionService : ConnectionService() {

  override fun onCreateIncomingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?,
  ): Connection {
    Log.i(TAG, "onCreateIncomingConnection request=${request?.address} extras=${request?.extras?.keySet()}")
    // The outer Bundle passed to addNewIncomingCall contains both the address
    // and our custom extras nested under EXTRA_INCOMING_CALL_EXTRAS. Android's
    // Telecom framework copies those nested extras FLAT into request.extras, but
    // on some Samsung builds the nesting is preserved. Try both paths.
    val outerExtras = request?.extras
    val innerExtras = outerExtras?.getBundle(android.telecom.TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
    val extras = innerExtras?.takeIf { it.containsKey(EXTRA_INVITE_ID) } ?: outerExtras
    val inviteId = extras?.getString(EXTRA_INVITE_ID).orEmpty()
    val callerNumber = extras?.getString(EXTRA_CALLER_NUMBER).orEmpty()
    val callerName = extras?.getString(EXTRA_CALLER_NAME).orEmpty()
    val pbxCallId = extras?.getString(EXTRA_PBX_CALL_ID).orEmpty()
    Log.i(TAG, "onCreateIncomingConnection extras resolved: inviteId=$inviteId callerNumber=$callerNumber callerName=$callerName pbxCallId=$pbxCallId (innerExtras=${innerExtras != null})")

    val connection = ConnectIncomingConnection(
      applicationContext,
      inviteId = inviteId,
      callerNumber = callerNumber,
      callerName = callerName,
      pbxCallId = pbxCallId,
    )

    val handleUri = request?.address ?: Uri.fromParts("tel", callerNumber.ifEmpty { "unknown" }, null)
    connection.setAddress(handleUri, TelecomManager.PRESENTATION_ALLOWED)
    if (callerName.isNotEmpty()) {
      connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
    }
    connection.setAudioModeIsVoip(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      connection.connectionProperties = Connection.PROPERTY_SELF_MANAGED
    }
    // Capabilities for SELF_MANAGED: HOLD + MUTE are honored by SystemUI's
    // call controls. We do NOT add SUPPORT_HOLD because some OEM call UIs
    // route the Hold button into the native dialer when present.
    connection.connectionCapabilities = Connection.CAPABILITY_MUTE
    connection.setRinging()

    TelecomBridge.registerActiveConnection(inviteId, connection)
    Log.i(TAG, "onCreateIncomingConnection inviteId=$inviteId from=$callerNumber name=$callerName — Connection set RINGING")
    return connection
  }

  override fun onCreateIncomingConnectionFailed(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?,
  ) {
    Log.w(TAG, "onCreateIncomingConnectionFailed account=$connectionManagerPhoneAccount request=$request")
    val inviteId = request?.extras?.getString(EXTRA_INVITE_ID).orEmpty()
    TelecomBridge.notifyConnectionFailed(inviteId, "create_failed")
  }

  override fun onCreateOutgoingConnection(
    connectionManagerPhoneAccount: PhoneAccountHandle?,
    request: ConnectionRequest?,
  ): Connection {
    // Outgoing calls are not yet routed through Telecom in this app — JS
    // dials directly via JsSIP. Returning a minimal disconnected Connection
    // satisfies the Telecom contract if the OS ever asks us for one.
    val c = ConnectIncomingConnection(applicationContext, "", "", "", "")
    c.setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    return c
  }

  companion object {
    private const val TAG = "ConnectConnectionSvc"

    /**
     * Bundle keys for extras passed through TelecomManager.addNewIncomingCall
     * to onCreateIncomingConnection. Kept stable so a future native module
     * change does not silently drop the inviteId.
     */
    const val EXTRA_INVITE_ID = "connect_invite_id"
    const val EXTRA_CALLER_NUMBER = "connect_caller_number"
    const val EXTRA_CALLER_NAME = "connect_caller_name"
    const val EXTRA_PBX_CALL_ID = "connect_pbx_call_id"
  }
}
