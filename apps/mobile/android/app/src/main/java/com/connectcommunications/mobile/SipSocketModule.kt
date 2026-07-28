package com.connectcommunications.mobile

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Purpose-built WebSocket transport for the SIP connection (JsSIP custom socket).
 *
 * Exists because React Native's built-in WebSocketModule is unusable on
 * T-Mobile's IPv6-only network: it hardcodes a 10 s connect timeout and
 * connects addresses in system DNS order, and the DNS64-synthesized IPv6
 * address for the PBX blackholes — so EVERY fresh SIP connect stalls ~10.5 s
 * before falling back to IPv4 (measured live 2026-07-28: "UA connecting"
 * 00:20:52.9 → "UA connected" 00:21:03.4). That stall was the entire
 * cold-start answer delay.
 *
 * Differences from the stock module:
 *  • IPv4-first DNS ordering — IPv4 (via 464XLAT on IPv6-only carriers)
 *    connects in ~300-500 ms; IPv6 addresses are kept as fallback.
 *  • 6 s connect timeout per route instead of 10 s.
 *  • Native-thread WebSocket pings every 30 s — keeps the CGNAT/NAT64
 *    mapping alive even while JS timers are frozen in the background
 *    (Android suspends JS timers; OkHttp's ping scheduler keeps running).
 */
class SipSocketModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "SipSocketModule"
    const val EVENT_OPEN = "SipSocket_open"
    const val EVENT_MESSAGE = "SipSocket_message"
    const val EVENT_CLOSE = "SipSocket_close"

    private val ipv4FirstDns = object : Dns {
      override fun lookup(hostname: String): List<InetAddress> {
        val all: List<InetAddress> = Dns.SYSTEM.lookup(hostname)
        val v4 = all.filterIsInstance<Inet4Address>()
        return if (v4.isEmpty()) all else v4 + all.filterNot { it is Inet4Address }
      }
    }

    // Shared client: connection pool + ping scheduler threads are reused.
    private val client: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .dns(ipv4FirstDns)
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    }
  }

  private val sockets = ConcurrentHashMap<String, WebSocket>()

  override fun getName(): String = "SipSocket"

  private fun emit(event: String, params: com.facebook.react.bridge.WritableMap) {
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(event, params)
    } catch (t: Throwable) {
      Log.w(TAG, "emit $event failed: ${t.message}")
    }
  }

  @ReactMethod
  fun connect(socketId: String, url: String) {
    Log.i(TAG, "connect id=$socketId url=$url")
    val request = Request.Builder()
      .url(url)
      // JsSIP requires the "sip" WebSocket subprotocol (RFC 7118).
      .addHeader("Sec-WebSocket-Protocol", "sip")
      .build()
    val startedAt = System.currentTimeMillis()
    val ws = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.i(TAG, "onOpen id=$socketId in ${System.currentTimeMillis() - startedAt}ms")
        emit(EVENT_OPEN, Arguments.createMap().apply {
          putString("id", socketId)
          putDouble("connectMs", (System.currentTimeMillis() - startedAt).toDouble())
        })
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        emit(EVENT_MESSAGE, Arguments.createMap().apply {
          putString("id", socketId)
          putString("data", text)
        })
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        // SIP over WS is text, but tolerate binary frames by decoding UTF-8.
        emit(EVENT_MESSAGE, Arguments.createMap().apply {
          putString("id", socketId)
          putString("data", bytes.utf8())
        })
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.i(TAG, "onClosed id=$socketId code=$code reason=$reason")
        sockets.remove(socketId, webSocket)
        emit(EVENT_CLOSE, Arguments.createMap().apply {
          putString("id", socketId)
          putInt("code", code)
          putString("reason", reason)
          putBoolean("wasClean", true)
        })
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.w(TAG, "onFailure id=$socketId after ${System.currentTimeMillis() - startedAt}ms: ${t.message}")
        sockets.remove(socketId, webSocket)
        emit(EVENT_CLOSE, Arguments.createMap().apply {
          putString("id", socketId)
          putInt("code", 1006)
          putString("reason", t.message ?: "connection failure")
          putBoolean("wasClean", false)
        })
      }
    })
    sockets[socketId] = ws
  }

  @ReactMethod
  fun send(socketId: String, data: String) {
    val ws = sockets[socketId]
    if (ws == null) {
      Log.w(TAG, "send: no socket for id=$socketId")
      return
    }
    if (!ws.send(data)) {
      Log.w(TAG, "send: enqueue failed (socket closing/closed) id=$socketId")
    }
  }

  @ReactMethod
  fun close(socketId: String, code: Int, reason: String?) {
    val ws = sockets.remove(socketId)
    if (ws != null) {
      try {
        // 1000 = normal closure; OkHttp requires a valid close code.
        ws.close(if (code in 1000..4999) code else 1000, reason ?: "")
      } catch (t: Throwable) {
        Log.w(TAG, "close failed id=$socketId: ${t.message}")
        try { ws.cancel() } catch (_: Throwable) {}
      }
    }
  }

  // Required stubs for NativeEventEmitter on RN >= 0.65.
  @ReactMethod
  fun addListener(eventName: String?) { /* no-op */ }

  @ReactMethod
  fun removeListeners(count: Int?) { /* no-op */ }
}
