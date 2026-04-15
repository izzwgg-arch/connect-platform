package com.connectcommunications.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Native FCM handler that intercepts INCOMING_CALL data messages and wakes the
 * React activity into the app's own full-screen incoming call UI before the JS
 * runtime is fully booted. Expo's notification handling is still forwarded via
 * reflection so regular push handling remains intact.
 */
public class IncomingCallFirebaseService extends FirebaseMessagingService {

    private static final String TAG = "IncomingCallService";
    private static final String CACHE_FILE = "pending_call_native.json";
    private static final String EXPO_SERVICE_CLASS =
        "expo.modules.notifications.service.ExpoFirebaseMessagingService";
    private static final String CHANNEL_ID = "connect-incoming-ui-v3";
    private static final int NOTIFICATION_ID_BASE = 41001;
    private static final String EXTRA_SHOW_INCOMING_CALL = "connect_show_incoming_call";
    private static MediaPlayer ringtonePlayer = null;

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        String type = data.get("type");
        Map<String, String> appData = data;

        if (type == null) {
            String bodyStr = data.get("body");
            if (bodyStr != null) {
                try {
                    JSONObject bodyJson = new JSONObject(bodyStr);
                    type = bodyJson.optString("type", null);
                    HashMap<String, String> merged = new HashMap<>(data);
                    Iterator<String> keys = bodyJson.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        merged.put(k, bodyJson.optString(k, ""));
                    }
                    appData = merged;
                    Log.i(TAG, "[CALL_INCOMING] parsed Expo body envelope, type=" + type);
                } catch (Exception e) {
                    Log.w(TAG, "[CALL_INCOMING] body parse failed: " + e.getMessage());
                }
            }
        }

        Log.i(TAG, "[CALL_INCOMING] onMessageReceived type=" + type
                + " dataKeys=" + data.keySet()
                + " appDataKeys=" + appData.keySet());

        if ("INCOMING_CALL".equals(type)) {
            try {
                handleIncomingCallNative(appData);
            } catch (Exception e) {
                Log.e(TAG, "[CALL_INCOMING] handleIncomingCallNative failed: " + e.getMessage(), e);
            }
        } else if ("INVITE_CLAIMED".equals(type)
                || "INVITE_CANCELED".equals(type)
                || "MISSED_CALL".equals(type)) {
            try {
                handleCallTerminationNative(type, appData);
            } catch (Exception e) {
                Log.e(TAG, "[CALL_INCOMING] handleCallTerminationNative failed: " + e.getMessage(), e);
            }
        }

        forwardToExpo("onMessageReceived", RemoteMessage.class, remoteMessage);
    }

    @Override
    public void onNewToken(String token) {
        forwardToExpo("onNewToken", String.class, token);
    }

    private void forwardToExpo(String methodName, Class<?> paramType, Object param) {
        try {
            Class<?> cls = Class.forName(EXPO_SERVICE_CLASS);
            Object instance = cls.getDeclaredConstructor().newInstance();
            Method attach = cls.getSuperclass().getSuperclass()
                              .getSuperclass().getDeclaredMethod("attachBaseContext", Context.class);
            attach.setAccessible(true);
            attach.invoke(instance, getBaseContext());
            Method method = cls.getDeclaredMethod(methodName, paramType);
            method.setAccessible(true);
            method.invoke(instance, param);
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] forwardToExpo(" + methodName + ") failed: " + e.getMessage());
        }
    }

    private void handleIncomingCallNative(Map<String, String> data) {
        String inviteId = data.get("inviteId");
        if (inviteId == null || inviteId.isEmpty()) inviteId = data.get("callId");
        String fromNum = data.get("fromNumber");
        if (fromNum == null || fromNum.isEmpty()) fromNum = data.get("from");
        String fromDisp = data.get("fromDisplay");

        String displayName = (fromDisp != null && !fromDisp.isEmpty())
            ? fromDisp
            : (fromNum != null && !fromNum.isEmpty() ? fromNum : "Unknown");

        Log.i(TAG, "[CALL_INCOMING] native handler inviteId=" + inviteId + " from=" + fromNum);
        writeCacheFile(data, inviteId, fromNum, fromDisp);
        startIncomingCallRingtone();
        launchIncomingCallUi(data, inviteId, displayName, fromNum);
    }

    private void handleCallTerminationNative(String type, Map<String, String> data) {
        String inviteId = data.get("inviteId");
        if (inviteId == null || inviteId.isEmpty()) inviteId = data.get("callId");
        Log.i(TAG, "[CALL_INCOMING] native termination type=" + type + " inviteId=" + inviteId);
        cancelIncomingCallNotification(inviteId);
        stopIncomingCallRingtone();
        deleteCacheFile();
    }

    private void launchIncomingCallUi(Map<String, String> data, String inviteId, String displayName, String fromNum) {
        ensureIncomingCallChannel();
        int notificationId = notificationIdForInvite(inviteId);
        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        Intent launchIntent = buildIncomingCallIntent("open", data, inviteId, fromNum);
        PendingIntent fullScreenIntent = PendingIntent.getActivity(
            this,
            notificationId,
            launchIntent,
            pendingIntentFlags
        );
        PendingIntent answerIntent = PendingIntent.getActivity(
            this,
            notificationId + 10000,
            buildIncomingCallIntent("answer", data, inviteId, fromNum),
            pendingIntentFlags
        );
        PendingIntent declineIntent = PendingIntent.getActivity(
            this,
            notificationId + 20000,
            buildIncomingCallIntent("decline", data, inviteId, fromNum),
            pendingIntentFlags
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.notification_icon)
            .setContentTitle("Incoming call")
            .setContentText(displayName)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setVibrate(new long[] { 0, 350, 250, 350 })
            .setTimeoutAfter(45_000)
            .setContentIntent(fullScreenIntent)
            .setFullScreenIntent(fullScreenIntent, true)
            .addAction(0, "Decline", declineIntent)
            .addAction(0, "Answer", answerIntent);

        NotificationManagerCompat.from(this).notify(notificationId, builder.build());
        Log.i(TAG, "[CALL_INCOMING] posted full-screen incoming call notification");
    }

    private Intent buildIncomingCallIntent(
        String action,
        Map<String, String> data,
        String inviteId,
        String fromNum
    ) {
        Uri.Builder uriBuilder = new Uri.Builder()
            .scheme("com.connectcommunications.mobile")
            .authority("incoming-call")
            .appendQueryParameter("action", action);

        appendQueryParameter(uriBuilder, "inviteId", inviteId);
        appendQueryParameter(uriBuilder, "callId", data.get("callId"));
        appendQueryParameter(uriBuilder, "fromNumber", fromNum);
        appendQueryParameter(uriBuilder, "fromDisplay", data.get("fromDisplay"));
        appendQueryParameter(uriBuilder, "toExtension", data.get("toExtension"));
        appendQueryParameter(uriBuilder, "tenantId", data.get("tenantId"));
        appendQueryParameter(uriBuilder, "pbxCallId", data.get("pbxCallId"));
        appendQueryParameter(uriBuilder, "pbxSipUsername", data.get("pbxSipUsername"));
        appendQueryParameter(uriBuilder, "sipCallTarget", data.get("sipCallTarget"));
        appendQueryParameter(uriBuilder, "timestamp", data.get("timestamp"));

        Intent intent = new Intent(Intent.ACTION_VIEW, uriBuilder.build(), this, MainActivity.class);
        intent.setPackage(getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_SINGLE_TOP
            | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(EXTRA_SHOW_INCOMING_CALL, true);
        if (inviteId != null) intent.putExtra("inviteId", inviteId);
        if (fromNum != null) intent.putExtra("fromNumber", fromNum);
        return intent;
    }

    private void appendQueryParameter(Uri.Builder builder, String key, String value) {
        if (value != null && !value.isEmpty()) {
            builder.appendQueryParameter(key, value);
        }
    }

    private void ensureIncomingCallChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Incoming Call UI",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Wakes the Connect app into its incoming call screen.");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 350, 250, 350 });
        channel.setSound(null, null);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private synchronized void startIncomingCallRingtone() {
        stopIncomingCallRingtone();
        try {
            MediaPlayer player = MediaPlayer.create(this, R.raw.connect_default_ringtone);
            if (player == null) {
                Log.w(TAG, "[CALL_INCOMING] could not create native ringtone player");
                return;
            }
            player.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            );
            player.setLooping(true);
            player.setOnCompletionListener((mp) -> stopIncomingCallRingtone());
            player.setOnErrorListener((mp, what, extra) -> {
                Log.w(TAG, "[CALL_INCOMING] native ringtone playback error what=" + what + " extra=" + extra);
                stopIncomingCallRingtone();
                return true;
            });
            player.start();
            ringtonePlayer = player;
            Log.i(TAG, "[CALL_INCOMING] native ringtone playback started");
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] startIncomingCallRingtone failed: " + e.getMessage());
            stopIncomingCallRingtone();
        }
    }

    public static synchronized void stopIncomingCallRingtone() {
        if (ringtonePlayer == null) return;
        try {
            if (ringtonePlayer.isPlaying()) {
                ringtonePlayer.stop();
            }
        } catch (Exception ignored) {
        }
        try {
            ringtonePlayer.release();
        } catch (Exception ignored) {
        }
        ringtonePlayer = null;
    }

    private void cancelIncomingCallNotification(String inviteId) {
        NotificationManagerCompat.from(this).cancel(notificationIdForInvite(inviteId));
    }

    private int notificationIdForInvite(String inviteId) {
        if (inviteId == null || inviteId.isEmpty()) return NOTIFICATION_ID_BASE;
        int hash = inviteId.hashCode();
        if (hash == Integer.MIN_VALUE) hash = 0;
        return NOTIFICATION_ID_BASE + Math.abs(hash % 10000);
    }

    private void writeCacheFile(Map<String, String> data, String inviteId, String fromNum, String fromDisp) {
        try {
            JSONObject json = new JSONObject();
            for (Map.Entry<String, String> e : data.entrySet()) {
                json.put(e.getKey(), e.getValue());
            }
            if (inviteId != null) json.put("inviteId", inviteId);
            if (fromNum != null) json.put("fromNumber", fromNum);
            if (fromDisp != null) json.put("fromDisplay", fromDisp);
            json.put("_nativeCallAdded", true);
            json.put("_storedAt", System.currentTimeMillis());

            File cacheFile = new File(getCacheDir(), CACHE_FILE);
            FileWriter fw = new FileWriter(cacheFile, false);
            fw.write(json.toString());
            fw.close();
            Log.i(TAG, "[CALL_INCOMING] cache file written: " + cacheFile.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] writeCacheFile failed: " + e.getMessage());
        }
    }

    private void deleteCacheFile() {
        try {
            File file = new File(getCacheDir(), CACHE_FILE);
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "[CALL_INCOMING] failed to delete cache file");
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] deleteCacheFile failed: " + e.getMessage());
        }
    }

    @Override
    public void onDestroy() {
        stopIncomingCallRingtone();
        super.onDestroy();
    }
}
