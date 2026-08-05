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

  /** When this Connection was created — read by the stale-connection sweep. */
  val createdAtMs: Long = System.currentTimeMillis()

  init {
    // Ring-phase self-destruct (RSBK101 2026-08-04): an INCOMING_CALL push
    // that raced past its own cancel creates a Connection nothing will ever
    // terminate — it then pins call-audio state process-wide (and disarms
    // resetCallAudioStateIfIdle, which skips while any Connection lives),
    // silencing all media playback until the app is force-stopped. No real
    // ring lasts anywhere near this long (PBX ring timeout ≤ ~60s), so a
    // Connection still RINGING at the deadline is a leak by definition.
    // Anchors (activateOnAdd) go ACTIVE immediately and are exempt.
    if (!activateOnAdd) {
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        try {
          if (state == STATE_RINGING) {
            Log.w(TAG, "ring self-destruct inviteId=$inviteId — still RINGING after ${RING_SELF_DESTRUCT_MS}ms, terminating as missed")
            terminate("missed")
          }
        } catch (t: Throwable) {
          Log.w(TAG, "ring self-destruct failed inviteId=$inviteId: ${t.message}")
        }
      }, RING_SELF_DESTRUCT_MS)
    }
  }

  override fun onShowIncomingCallUi() {
    // System wants us to show our own UI. Telecom invokes this only AFTER the
    // call has been fully added, which makes it the guaranteed-timing hook to
    // flip an answer-time anchor to ACTIVE (see activateOnAdd docs).
    Log.i(TAG, "onShowIncomingCallUi inviteId=$inviteId activateOnAdd=$activateOnAdd")
    if (activateOnAdd) {
      setActive()
      noteActivatedAndApplyAppRoute()
      Log.i(TAG, "onShowIncomingCallUi inviteId=$inviteId — anchor flipped to ACTIVE")
    }
  }

  override fun onAnswer() {
    Log.i(TAG, "onAnswer inviteId=$inviteId — flipping to ACTIVE and notifying JS")
    setActive()
    noteActivatedAndApplyAppRoute()
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

  /**
   * When this Connection flipped ACTIVE (0 = not yet). For a short window
   * after activation, ANY route Telecom applies that differs from the app's
   * chosen route is corrected — Telecom's SWITCH_BASELINE_ROUTE stomp is not
   * synchronized with activation (observed live 2026-07-29: first audio
   * state was still correct, the earpiece baseline landed ~500ms LATER, so a
   * one-shot first-callback guard missed it and audio audibly dipped for
   * half a second). After the window the Connection never interferes again,
   * so genuine user/OS route changes (headset button, device change) are
   * always respected — no fight loops.
   */
  var activeAtMs: Long = 0L
    private set

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
    if (state == null || this.state != STATE_ACTIVE) return
    val sinceActive = if (activeAtMs > 0) System.currentTimeMillis() - activeAtMs else Long.MAX_VALUE
    if (sinceActive <= ROUTE_ENFORCE_WINDOW_MS) {
      val want = TelecomBridge.lastRequestedRoute
      if (want != null && want != state.route) {
        Log.i(
          TAG,
          "onCallAudioStateChanged inviteId=$inviteId — enforcing app route " +
            CallAudioState.audioRouteToString(want) + " over activation stomp (+${sinceActive}ms)",
        )
        setAudioRoute(want)
      }
    }
  }

  /**
   * Mark activation and pre-empt Telecom's baseline route with the app's
   * chosen route. Called right after every setActive() so the pending-route
   * machinery resolves toward the app's choice instead of earpiece.
   */
  private fun noteActivatedAndApplyAppRoute() {
    activeAtMs = System.currentTimeMillis()
    val want = TelecomBridge.lastRequestedRoute ?: return
    try {
      Log.i(TAG, "activation — pre-applying app route " + CallAudioState.audioRouteToString(want))
      setAudioRoute(want)
    } catch (t: Throwable) {
      Log.w(TAG, "activation route pre-apply failed: ${t.message}")
    }
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
    noteActivatedAndApplyAppRoute()
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
    /** How long after ACTIVE the app's chosen route is enforced over Telecom
     *  stomps. Short enough to never fight a real user/OS change. */
    private const val ROUTE_ENFORCE_WINDOW_MS = 3000L
    /** A Connection still RINGING this long after creation is a leaked ghost
     *  ring (cancel push beat the ring push) — no PBX ring runs this long. */
    private const val RING_SELF_DESTRUCT_MS = 120_000L
  }
}
