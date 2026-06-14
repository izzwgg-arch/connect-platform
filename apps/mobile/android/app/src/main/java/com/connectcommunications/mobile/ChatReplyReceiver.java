package com.connectcommunications.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;

import androidx.core.app.RemoteInput;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Handles the inline "Reply" action on chat notifications. Reads the typed text
 * via RemoteInput, sends it to the Connect chat API using the auth token + API
 * base that JS mirrors into the {@code connect_auth_mirror} SharedPreferences on
 * login, then updates the conversation's MessagingStyle notification to show the
 * sent reply (or an error so the reply box resets and the user can retry).
 *
 * Sending happens off the main thread via {@link #goAsync()} so a killed/cold
 * app can still deliver the reply without the React runtime being up.
 */
public class ChatReplyReceiver extends BroadcastReceiver {
    private static final String TAG = "ChatReplyReceiver";

    public static final String ACTION_REPLY = "com.connectcommunications.mobile.ACTION_CHAT_REPLY";
    public static final String KEY_TEXT_REPLY = "key_text_reply";
    public static final String EXTRA_CONVERSATION_ID = "conversationId";
    public static final String EXTRA_NOTIF_ID = "notifId";
    public static final String EXTRA_CHANNEL_ID = "channelId";
    public static final String EXTRA_SENDER_NAME = "senderName";

    static final String AUTH_PREFS = "connect_auth_mirror";
    static final String PREF_TOKEN = "auth_token";
    static final String PREF_API_BASE = "api_base";

    @Override
    public void onReceive(final Context context, final Intent intent) {
        if (!ACTION_REPLY.equals(intent.getAction())) return;

        Bundle remoteInput = RemoteInput.getResultsFromIntent(intent);
        CharSequence replySeq = remoteInput != null ? remoteInput.getCharSequence(KEY_TEXT_REPLY) : null;
        final String replyText = replySeq != null ? replySeq.toString().trim() : "";
        final String conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID);
        final int notifId = intent.getIntExtra(EXTRA_NOTIF_ID, -1);
        final String channelId = intent.getStringExtra(EXTRA_CHANNEL_ID);
        final String senderName = intent.getStringExtra(EXTRA_SENDER_NAME);

        Log.i(TAG, "[CHAT_REPLY] received conv=" + conversationId + " len=" + replyText.length());

        if (replyText.isEmpty() || conversationId == null || conversationId.isEmpty()) {
            return;
        }

        final Context appCtx = context.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> {
            boolean ok = false;
            try {
                ok = sendReply(appCtx, conversationId, replyText);
            } catch (Throwable t) {
                Log.w(TAG, "[CHAT_REPLY] send_failed: " + t.getMessage());
            }
            try {
                if (ok) {
                    IncomingCallFirebaseService.postChatMessageNotification(
                        appCtx, channelId, conversationId, null, senderName, replyText, true);
                    Log.i(TAG, "[CHAT_REPLY] sent_ok conv=" + conversationId);
                } else {
                    IncomingCallFirebaseService.postChatMessageNotification(
                        appCtx, channelId, conversationId, null, senderName,
                        "\u26A0\uFE0F Not sent \u2014 tap to open and retry", true);
                    Log.w(TAG, "[CHAT_REPLY] sent_fail conv=" + conversationId);
                }
            } catch (Throwable t) {
                Log.w(TAG, "[CHAT_REPLY] repost_failed: " + t.getMessage());
            }
            pending.finish();
        }, "chat-reply-send").start();
    }

    private boolean sendReply(Context ctx, String conversationId, String text) throws Exception {
        SharedPreferences prefs = ctx.getSharedPreferences(AUTH_PREFS, Context.MODE_PRIVATE);
        String token = prefs.getString(PREF_TOKEN, null);
        String apiBase = prefs.getString(PREF_API_BASE, "https://app.connectcomunications.com/api");
        if (token == null || token.isEmpty()) {
            Log.w(TAG, "[CHAT_REPLY] no_auth_token_mirrored");
            return false;
        }
        String base = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;
        URL url = new URL(base + "/chat/threads/" + conversationId + "/messages");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            JSONObject bodyJson = new JSONObject();
            bodyJson.put("body", text);
            bodyJson.put("type", "TEXT");
            byte[] payload = bodyJson.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int code = conn.getResponseCode();
            Log.i(TAG, "[CHAT_REPLY] http_status=" + code + " conv=" + conversationId);
            return code >= 200 && code < 300;
        } finally {
            conn.disconnect();
        }
    }
}
