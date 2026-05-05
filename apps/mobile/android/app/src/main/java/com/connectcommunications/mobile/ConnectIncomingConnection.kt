package com.connectcommunications.mobile

import android.content.Context
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.util.Log

/**
 * Per-call Telecom Connection. The OS shows the system incoming-call UI
 * (lock-screen ringer + heads-up banner) and routes user actions
 * (Answer / Decline / Mute / Hangup) into the override methods below.
 *
 * Each callback forwards the action to the JS layer through
 * {@link TelecomBridge}. The JS side owns the SIP UA — Telecom owns the UI.
 */
class ConnectIncomingConnection(
  private val context: Context,
  val inviteId: String,
  val callerNumber: String,
  val callerName: String,
  val pbxCallId: String,
) : Connection() {

  override fun onShowIncomingCallUi() {
    // System wants us to show our own UI. For SELF_MANAGED with no app UI
    // visible the OS already posts its own ringing notification, so this is
    // a no-op. We log so diagnostics can prove the OS asked us.
    Log.i(TAG, "onShowIncomingCallUi inviteId=$inviteId")
  }

  override fun onAnswer() {
    Log.i(TAG, "onAnswer inviteId=$inviteId — flipping to ACTIVE and notifying JS")
    setActive()
    TelecomBridge.notifyAnswer(inviteId, callerNumber, callerName, pbxCallId)
  }

  override fun onAnswer(videoState: Int) {
    onAnswer()
  }

  override fun onReject() {
    Log.i(TAG, "onReject inviteId=$inviteId — disconnecting REJECTED and notifying JS")
    TelecomBridge.notifyReject(inviteId, "user_rejected")
    setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
    destroy()
    TelecomBridge.unregisterActiveConnection(inviteId)
  }

  override fun onReject(replyMessage: String?) {
    onReject()
  }

  override fun onDisconnect() {
    Log.i(TAG, "onDisconnect inviteId=$inviteId — local hangup, notifying JS")
    TelecomBridge.notifyDisconnect(inviteId, "user_hangup")
    setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    destroy()
    TelecomBridge.unregisterActiveConnection(inviteId)
  }

  override fun onAbort() {
    Log.i(TAG, "onAbort inviteId=$inviteId")
    TelecomBridge.notifyDisconnect(inviteId, "system_abort")
    setDisconnected(DisconnectCause(DisconnectCause.OTHER))
    destroy()
    TelecomBridge.unregisterActiveConnection(inviteId)
  }

  /**
   * External hook (JS bridge) — flip this Connection's audio state into
   * ACTIVE without going through onAnswer. Used when the SIP INVITE is
   * answered programmatically (e.g. headset hookswitch via a future
   * integration) and we just need the OS UI to reflect "in call".
   */
  fun markActive() {
    Log.i(TAG, "markActive inviteId=$inviteId")
    setActive()
  }

  /**
   * External hook (JS bridge) — terminate this Connection cleanly when the
   * SIP layer reports the call ended (remote hangup, network loss, etc.).
   */
  fun terminate(reason: String) {
    Log.i(TAG, "terminate inviteId=$inviteId reason=$reason")
    val cause = when (reason) {
      "remote_hangup" -> DisconnectCause(DisconnectCause.REMOTE)
      "missed" -> DisconnectCause(DisconnectCause.MISSED)
      "canceled" -> DisconnectCause(DisconnectCause.CANCELED)
      "rejected" -> DisconnectCause(DisconnectCause.REJECTED)
      else -> DisconnectCause(DisconnectCause.OTHER)
    }
    setDisconnected(cause)
    destroy()
    TelecomBridge.unregisterActiveConnection(inviteId)
  }

  companion object {
    private const val TAG = "ConnectIncomingConn"
  }
}
