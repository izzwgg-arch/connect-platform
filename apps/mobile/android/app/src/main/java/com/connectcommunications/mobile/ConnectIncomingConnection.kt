package com.connectcommunications.mobile

import android.content.Context
import android.telecom.CallAudioState
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
  /**
   * Answer-time anchor mode: the SIP call is already live and this Connection
   * exists purely so the OS treats the process as hosting an ACTIVE call.
   * The ACTIVE transition MUST happen after Telecom has added the call —
   * setActive() inside onCreateIncomingConnection is silently dropped and the
   * call stays RINGING (observed live 2026-07-28: Telecom dump showed
   * state=RINGING at swipe-kill despite our "set ACTIVE" log, and a RINGING
   * call grants no swipe-survival protection).
   */
  private val activateOnAdd: Boolean = false,
) : Connection() {

  override fun onShowIncomingCallUi() {
    // System wants us to show our own UI. Telecom invokes this only AFTER the
    // call has been fully added, which makes it the guaranteed-timing hook to
    // flip an answer-time anchor to ACTIVE (see activateOnAdd docs).
    Log.i(TAG, "onShowIncomingCallUi inviteId=$inviteId activateOnAdd=$activateOnAdd")
    if (activateOnAdd) {
      setActive()
      Log.i(TAG, "onShowIncomingCallUi inviteId=$inviteId — anchor flipped to ACTIVE")
    }
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
    disconnectAndDestroy(DisconnectCause(DisconnectCause.REJECTED))
  }

  override fun onReject(replyMessage: String?) {
    onReject()
  }

  override fun onDisconnect() {
    Log.i(TAG, "onDisconnect inviteId=$inviteId — local hangup, notifying JS")
    TelecomBridge.notifyDisconnect(inviteId, "user_hangup")
    disconnectAndDestroy(DisconnectCause(DisconnectCause.LOCAL))
  }

  override fun onAbort() {
    Log.i(TAG, "onAbort inviteId=$inviteId")
    TelecomBridge.notifyDisconnect(inviteId, "system_abort")
    disconnectAndDestroy(DisconnectCause(DisconnectCause.OTHER))
  }

  override fun onCallAudioStateChanged(state: CallAudioState?) {
    // Telecom is the routing authority while this Connection is ACTIVE.
    // Log every route flip so speaker/BT problems are diagnosable from
    // logcat, and so we can see Telecom resetting the route on activation.
    Log.i(
      TAG,
      "onCallAudioStateChanged inviteId=$inviteId route=" +
        (state?.let { CallAudioState.audioRouteToString(it.route) } ?: "null") +
        " muted=${state?.isMuted}",
    )
  }

  /**
   * External hook (JS bridge via IncomingCallUiModule) — request an audio
   * route change through Telecom. This is the ONLY effective way to move
   * call audio while this self-managed Connection is ACTIVE.
   */
  fun requestAudioRoute(route: Int) {
    Log.i(TAG, "requestAudioRoute inviteId=$inviteId route=${CallAudioState.audioRouteToString(route)}")
    setAudioRoute(route)
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
    disconnectAndDestroy(cause)
  }

  /**
   * setDisconnected() + destroy() in the same synchronous frame can race
   * Telecom's transactional disconnect pipeline (Android 15/16
   * "cleanupVerifyCallState" transactions) and strand the SYSTEM-held
   * MODE_IN_COMMUNICATION audio state. Observed live 2026-07-28 on the test
   * device: audio mode stuck "in communication" (owner uid 1000 = Telecom)
   * for 80+ minutes after the last call ended with zero calls in
   * CallsManager — which blocks other apps (e.g. WhatsApp voice notes) from
   * recording. Deferring destroy() one main-looper tick gives Telecom a
   * frame to process the disconnect before the Connection object vanishes.
   * TelecomBridge.resetCallAudioStateIfIdle is the second line of defence.
   */
  private fun disconnectAndDestroy(cause: DisconnectCause) {
    setDisconnected(cause)
    android.os.Handler(android.os.Looper.getMainLooper()).post {
      try {
        destroy()
      } catch (t: Throwable) {
        Log.w(TAG, "deferred destroy failed inviteId=$inviteId: ${t.message}")
      }
    }
    TelecomBridge.unregisterActiveConnection(inviteId)
  }

  companion object {
    private const val TAG = "ConnectIncomingConn"
  }
}
