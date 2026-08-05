package com.connectcommunications.mobile;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.ActivityManager;
import android.content.pm.ResolveInfo;
import android.content.pm.PackageManager;
import android.os.PowerManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
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
import java.util.Locale;
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
    private static final String PRESENTATION_FULL_SCREEN = "full_screen";
    private static final String PRESENTATION_HEADS_UP = "heads_up";
    private static final String PRESENTATION_FOREGROUND_JS = "foreground_js";
    private static MediaPlayer ringtonePlayer = null;
    private static android.media.Ringtone systemRingtoneFallback = null;
    private static PowerManager.WakeLock incomingRingWakeLock = null;
    private static AudioManager ringAudioManager = null;
    private static AudioFocusRequest ringFocusRequest = null;

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
                // First audible sample ASAP (before disk / notification / full-screen work).
                // When the process is only alive for FCM, MainActivity is not resumed yet.
                if (!MainActivity.isHostResumedForIncoming()) {
                    startIncomingCallRingtone();
                }
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
        boolean appInForeground = isAppInForeground();
        boolean preferFullScreen = !appInForeground && shouldUseFullScreenUi();
        String presentationMode = appInForeground
            ? PRESENTATION_FOREGROUND_JS
            : (preferFullScreen ? PRESENTATION_FULL_SCREEN : PRESENTATION_HEADS_UP);

        Log.i(TAG, "[CALL_INCOMING] native handler inviteId=" + inviteId + " from=" + fromNum);
        if (PRESENTATION_FOREGROUND_JS.equals(presentationMode)) {
            Log.i(TAG, "[CALL_INCOMING] app already foregrounded; leaving incoming UI to React");
            writeCacheFile(
                data,
                inviteId,
                fromNum,
                fromDisp,
                false,
                presentationMode
            );
            stopIncomingCallRingtone("foreground_js_takeover");
            return;
        }
        writeCacheFile(
            data,
            inviteId,
            fromNum,
            fromDisp,
            true,
            presentationMode
        );
        launchIncomingCallUi(data, inviteId, displayName, fromNum, preferFullScreen);
    }

    private void handleCallTerminationNative(String type, Map<String, String> data) {
        String inviteId = data.get("inviteId");
        if (inviteId == null || inviteId.isEmpty()) inviteId = data.get("callId");
        Log.i(TAG, "[CALL_INCOMING] native termination type=" + type + " inviteId=" + inviteId);
        dismissIncomingCallUi(this, inviteId, "native_termination:" + type);
        deleteCacheFile();
    }

    private void launchIncomingCallUi(
        Map<String, String> data,
        String inviteId,
        String displayName,
        String fromNum,
        boolean preferFullScreen
    ) {
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
            .setContentIntent(fullScreenIntent);

        // Always use CallStyle so heads-up + full-screen paths share the same modern call UI.
        builder.setStyle(
            NotificationCompat.CallStyle.forIncomingCall(
                new androidx.core.app.Person.Builder()
                    .setName(displayName)
                    .setImportant(true)
                    .build(),
                declineIntent,
                answerIntent
            )
        );
        if (preferFullScreen) {
            builder.setFullScreenIntent(fullScreenIntent, true);
        }

        NotificationManagerCompat.from(this).notify(notificationId, builder.build());
        Log.i(TAG, "[CALL_INCOMING] posted incoming call notification mode=" + (preferFullScreen ? "full_screen" : "heads_up"));
        if (preferFullScreen) {
            triggerFullScreenIntent(fullScreenIntent, launchIntent);
        }
    }

    private void triggerFullScreenIntent(PendingIntent fullScreenIntent, Intent launchIntent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ActivityOptions options = ActivityOptions.makeBasic();
                options.setPendingIntentBackgroundActivityStartMode(
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                );
                fullScreenIntent.send(this, 0, launchIntent, null, null, null, options.toBundle());
            } else {
                fullScreenIntent.send();
            }
            Log.i(TAG, "[CALL_INCOMING] requested branded full-screen launch via pending intent");
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] full-screen pending intent launch failed: " + e.getMessage());
        }
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

    private boolean shouldUseFullScreenUi() {
        try {
            KeyguardManager keyguardManager = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            boolean deviceLocked = false;
            boolean isInteractive = true;

            if (keyguardManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                    deviceLocked = keyguardManager.isDeviceLocked();
                } else {
                    deviceLocked = keyguardManager.inKeyguardRestrictedInputMode();
                }
            }

            if (powerManager != null) {
                isInteractive = powerManager.isInteractive();
            }

            String foregroundPackage = getForegroundPackageName();
            String homePackage = getDefaultHomePackage();
            boolean isHomeIdle =
                (foregroundPackage != null &&
                    homePackage != null &&
                    homePackage.equals(foregroundPackage)) ||
                isLikelyLauncherPackage(foregroundPackage);
            boolean isConfidentOtherAppForeground =
                foregroundPackage != null &&
                !foregroundPackage.isEmpty() &&
                !foregroundPackage.equals(getPackageName()) &&
                !isLikelyLauncherPackage(foregroundPackage) &&
                (homePackage == null || !foregroundPackage.equals(homePackage)) &&
                !foregroundPackage.startsWith("com.android.systemui");

            // Default to full-screen unless we are confident another app is
            // actively foregrounded. This keeps home-screen / launcher / unknown
            // Samsung task states in the full-screen bucket instead of silently
            // dropping into the CallKeep floating path.
            boolean preferFullScreen =
                deviceLocked ||
                !isInteractive ||
                isHomeIdle ||
                !isConfidentOtherAppForeground;
            Log.i(
                TAG,
                "[CALL_INCOMING] presentation_decision"
                    + " locked=" + deviceLocked
                    + " interactive=" + isInteractive
                    + " foregroundPackage=" + foregroundPackage
                    + " homePackage=" + homePackage
                    + " otherAppForeground=" + isConfidentOtherAppForeground
                    + " fullScreen=" + preferFullScreen
            );
            return preferFullScreen;
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] shouldUseFullScreenUi failed: " + e.getMessage());
            return true;
        }
    }

    /** OEM launchers often differ from resolveActivity(CATEGORY_HOME); treat them as home idle. */
    private boolean isLikelyLauncherPackage(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        String lower = pkg.toLowerCase(Locale.US);
        if (lower.contains("launcher") && !lower.contains("settings")) {
            return true;
        }
        return lower.startsWith("com.sec.android.app.launcher")
            || lower.startsWith("com.huawei.android.launcher")
            || lower.startsWith("com.miui.home");
    }

    /**
     * True when the user is actually inside our React UI (MainActivity resumed).
     * Do not use RunningAppProcessInfo alone: FCM delivery often runs with the
     * process temporarily marked IMPORTANCE_FOREGROUND even when the app was
     * swiped away, which incorrectly skipped the native ringtone + CallStyle UI.
     */
    private boolean isAppInForeground() {
        try {
            return MainActivity.isHostResumedForIncoming();
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] isAppInForeground failed: " + e.getMessage());
            return false;
        }
    }

    private String getDefaultHomePackage() {
        try {
            Intent homeIntent = new Intent(Intent.ACTION_MAIN);
            homeIntent.addCategory(Intent.CATEGORY_HOME);
            ResolveInfo resolveInfo = getPackageManager().resolveActivity(homeIntent, PackageManager.MATCH_DEFAULT_ONLY);
            if (resolveInfo != null && resolveInfo.activityInfo != null && resolveInfo.activityInfo.packageName != null) {
                return resolveInfo.activityInfo.packageName;
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] getDefaultHomePackage failed: " + e.getMessage());
        }
        return null;
    }

    private String getForegroundPackageName() {
        try {
            ActivityManager activityManager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (activityManager == null) return null;
            ActivityManager.RunningAppProcessInfo best = null;
            for (ActivityManager.RunningAppProcessInfo processInfo : activityManager.getRunningAppProcesses()) {
                if (processInfo == null || processInfo.pkgList == null || processInfo.pkgList.length == 0) continue;
                if (
                    processInfo.importance != ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND &&
                    processInfo.importance != ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
                ) {
                    continue;
                }
                if (best == null || processInfo.importance < best.importance) {
                    best = processInfo;
                }
            }
            if (best != null && best.pkgList.length > 0) {
                return best.pkgList[0];
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] getForegroundPackageName failed: " + e.getMessage());
        }
        return null;
    }

    private void requestRingtoneAudioFocus() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            ringAudioManager = am;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes aa = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                AudioFocusRequest req = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(aa)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(focusChange -> { })
                    .build();
                ringFocusRequest = req;
                am.requestAudioFocus(req);
            } else {
                @SuppressWarnings("deprecation")
                int ignored = am.requestAudioFocus(
                    null,
                    AudioManager.STREAM_RING,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                );
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] requestRingtoneAudioFocus: " + e.getMessage());
        }
    }

    private static void abandonRingtoneAudioFocus() {
        try {
            if (ringAudioManager == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && ringFocusRequest != null) {
                ringAudioManager.abandonAudioFocusRequest(ringFocusRequest);
                ringFocusRequest = null;
            } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                @SuppressWarnings("deprecation")
                int ignored = ringAudioManager.abandonAudioFocus(null);
            }
            ringAudioManager = null;
        } catch (Exception ignored) {
        }
    }

    private synchronized void startIncomingCallRingtone() {
        stopIncomingCallRingtone("restart_before_new_call");
        try {
            requestRingtoneAudioFocus();
            Context appCtx = getApplicationContext();
            MediaPlayer player = MediaPlayer.create(appCtx, R.raw.connect_default_ringtone);
            if (player != null) {
                player.setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                );
                player.setLooping(true);
                player.setVolume(1f, 1f);
                player.setOnCompletionListener((mp) -> stopIncomingCallRingtone("native_completion"));
                player.setOnErrorListener((mp, what, extra) -> {
                    Log.w(TAG, "[CALL_INCOMING] native ringtone playback error what=" + what + " extra=" + extra);
                    stopIncomingCallRingtone("native_error");
                    return true;
                });
                player.start();
                ringtonePlayer = player;
                acquireIncomingRingWakeLock();
                Log.i(TAG, "[CALL_INCOMING] native ringtone playback started (media_player)");
                return;
            }
            Log.w(TAG, "[CALL_INCOMING] MediaPlayer.create returned null — trying system default ringtone");
            startSystemDefaultRingtoneFallback();
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] startIncomingCallRingtone failed: " + e.getMessage());
            startSystemDefaultRingtoneFallback();
        }
    }

    private void startSystemDefaultRingtoneFallback() {
        try {
            Uri uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE);
            if (uri == null) {
                uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            }
            if (uri == null) {
                Log.w(TAG, "[CALL_INCOMING] no system default ringtone URI");
                return;
            }
            android.media.Ringtone rt = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (rt == null) {
                Log.w(TAG, "[CALL_INCOMING] RingtoneManager.getRingtone returned null");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                rt.setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                );
                rt.setLooping(true);
            }
            rt.play();
            systemRingtoneFallback = rt;
            acquireIncomingRingWakeLock();
            Log.i(TAG, "[CALL_INCOMING] native ringtone playback started (system_fallback)");
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] system ringtone fallback failed: " + e.getMessage());
        }
    }

    private void acquireIncomingRingWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            synchronized (IncomingCallFirebaseService.class) {
                if (incomingRingWakeLock == null) {
                    incomingRingWakeLock = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "Connect:IncomingCallRing"
                    );
                    incomingRingWakeLock.setReferenceCounted(false);
                }
                if (!incomingRingWakeLock.isHeld()) {
                    incomingRingWakeLock.acquire(180_000L);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] acquireIncomingRingWakeLock: " + e.getMessage());
        }
    }

    private static void releaseIncomingRingWakeLock() {
        try {
            synchronized (IncomingCallFirebaseService.class) {
                if (incomingRingWakeLock != null && incomingRingWakeLock.isHeld()) {
                    incomingRingWakeLock.release();
                }
            }
        } catch (Exception ignored) {
        }
    }

    public static synchronized void stopIncomingCallRingtone() {
        stopIncomingCallRingtone("unspecified");
    }

    public static synchronized void stopIncomingCallRingtone(String reason) {
        if (systemRingtoneFallback != null) {
            Log.i(TAG, "[CALL_INCOMING] stopping system fallback ringtone reason=" + reason);
            try {
                systemRingtoneFallback.stop();
            } catch (Exception ignored) {
            }
            systemRingtoneFallback = null;
        }
        if (ringtonePlayer != null) {
            Log.i(TAG, "[CALL_INCOMING] native ringtone playback stopped reason=" + reason);
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
        releaseIncomingRingWakeLock();
        abandonRingtoneAudioFocus();
    }

    private static void cancelIncomingCallNotification(Context context, String inviteId) {
        NotificationManagerCompat.from(context).cancel(notificationIdForInvite(inviteId));
    }

    /** Removes the ongoing incoming notification only (keeps native ringtone playing). */
    public static void cancelIncomingCallNotificationOnly(Context context, String inviteId) {
        cancelIncomingCallNotification(context, inviteId);
        Log.i(TAG, "[CALL_INCOMING] cancelled incoming notification only inviteId=" + inviteId);
    }

    public static synchronized void dismissIncomingCallUi(
        Context context,
        String inviteId,
        String reason
    ) {
        cancelIncomingCallNotification(context, inviteId);
        stopIncomingCallRingtone(reason);
        Log.i(TAG, "[CALL_INCOMING] dismissed incoming ui inviteId=" + inviteId + " reason=" + reason);
    }

    private static int notificationIdForInvite(String inviteId) {
        if (inviteId == null || inviteId.isEmpty()) return NOTIFICATION_ID_BASE;
        int hash = inviteId.hashCode();
        if (hash == Integer.MIN_VALUE) hash = 0;
        return NOTIFICATION_ID_BASE + Math.abs(hash % 10000);
    }

    private void writeCacheFile(
        Map<String, String> data,
        String inviteId,
        String fromNum,
        String fromDisp,
        boolean nativeCallAdded,
        String presentationMode
    ) {
        try {
            JSONObject json = new JSONObject();
            for (Map.Entry<String, String> e : data.entrySet()) {
                json.put(e.getKey(), e.getValue());
            }
            if (inviteId != null) json.put("inviteId", inviteId);
            if (fromNum != null) json.put("fromNumber", fromNum);
            if (fromDisp != null) json.put("fromDisplay", fromDisp);
            json.put("_nativeCallAdded", nativeCallAdded);
            json.put("_nativePresentation", presentationMode);
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

    private static void appendQueryParameter(Uri.Builder builder, String key, String value) {
        if (value != null && !value.isEmpty()) {
            builder.appendQueryParameter(key, value);
        }
    }
}
