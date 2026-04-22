package com.connectcommunications.mobile;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.ActivityManager;
import android.app.ActivityManager.RunningAppProcessInfo;
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
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.facebook.react.bridge.Arguments;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import android.content.res.AssetFileDescriptor;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
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
    /** Logcat filter for cross-stack timeline (pair with JS `[CALL_FLOW]` in ReactNativeJS). */
    private static final String CALL_FLOW_TAG = "ConnectCallFlow";
    private static volatile String lastRingtoneInviteId = null;
    /**
     * Watchdog handler that auto-dismisses a stuck incoming call if nothing else
     * (INVITE_CLAIMED / INVITE_CANCELED / MISSED_CALL FCM, JS bridge dismiss, or
     * onNewIntent answer/decline) terminates it within the invite's expiry
     * window. Without this, the ringtone will play indefinitely if:
     *   - the cancel FCM is delayed (worker polls PBX every 5s),
     *   - the cancel FCM is suppressed (Android notification trampoline on
     *     cold-killed apps can drop custom handler calls),
     *   - or the app is uninstalled/reinstalled between the INCOMING_CALL and
     *     cancel pushes.
     *
     * 45s matches {@code CallInvite.expiresAt} on the server AND the notification's
     * {@code setTimeoutAfter(45_000)} — so the UI, notification, and ringtone all
     * expire in lockstep.
     */
    private static final long INCOMING_CALL_TIMEOUT_MS = 45_000L;
    private static volatile Handler mainHandler = null;
    private static volatile Runnable pendingRingtoneTimeout = null;
    private static final String CACHE_FILE = "pending_call_native.json";
    private static final String EXPO_SERVICE_CLASS =
        "expo.modules.notifications.service.ExpoFirebaseMessagingService";
    /** Bumped when channel sound / importance policy changes (Android caches channels by id). */
    private static final String CHANNEL_ID = "connect-incoming-ui-v6";
    private static final int NOTIFICATION_ID_BASE = 41001;
    private static final String EXTRA_SHOW_INCOMING_CALL = "connect_show_incoming_call";
    private static final String PRESENTATION_FULL_SCREEN = "full_screen";
    private static final String PRESENTATION_HEADS_UP = "heads_up";
    private static final String PRESENTATION_FOREGROUND_JS = "foreground_js";
    private static MediaPlayer ringtonePlayer = null;
    private static android.media.Ringtone systemRingtoneFallback = null;
    private static PowerManager.WakeLock incomingRingWakeLock = null;
    /**
     * Screen-on wake lock held briefly to force the display on when an incoming
     * call arrives while the device is locked and MainActivity is already
     * existing behind the keyguard. {@code setTurnScreenOn(true)} only takes
     * effect at activity creation — subsequent onNewIntent deliveries do NOT
     * wake the screen, which caused the "second call on lock screen shows no
     * UI" bug.
     */
    private static PowerManager.WakeLock incomingScreenWakeLock = null;
    private static AudioManager ringAudioManager = null;
    private static AudioFocusRequest ringFocusRequest = null;
    /** Flight recorder: ringtone start/stop timestamps for JS to read after warm-up. */
    public static volatile long ringtoneStartedAtMs = 0;
    public static volatile long ringtoneStoppedAtMs = 0;
    public static volatile String ringtoneSource = null;
    public static volatile String ringtoneStopReason = null;
    /**
     * Multi-call busy flag. Written by JS via IncomingCallUiModule.setInActiveCall()
     * whenever the CallSessionManager has an active call. While true, new FCM
     * INCOMING_CALL messages:
     *   - do NOT start the native ringtone
     *   - do NOT fire the full-screen intent
     * The JS CallWaitingBanner handles the waiting call instead.
     */
    public static volatile boolean inActiveCall = false;

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
                String inviteForRing = appData.get("inviteId");
                if (inviteForRing == null || inviteForRing.isEmpty()) {
                    inviteForRing = appData.get("callId");
                }
                JSONObject fcmMeta = new JSONObject();
                fcmMeta.put("fcmType", type);
                emitCallFlowNative("FCM_DATA_INCOMING_CALL", inviteForRing, fcmMeta);
                // Multi-call: when the JS side already has an active call, skip
                // the native ringtone + full-screen UI. The CallWaitingBanner
                // inside ActiveCallScreen handles the waiting invite instead.
                if (inActiveCall) {
                    Log.i(TAG, "[MULTICALL] incoming INVITE while in_active_call=true — suppressing native ringtone+full-screen");
                    fcmMeta.put("multicall_suppressed", true);
                    emitCallFlowNative("FCM_INCOMING_SUPPRESSED_MULTICALL", inviteForRing, fcmMeta);
                    // Still call handleIncomingCallNative to persist the pending_call_native
                    // cache file for JS rehydration. handleIncomingCallNative itself checks
                    // inActiveCall below and skips the full-screen intent there too.
                    handleIncomingCallNative(appData);
                } else {
                    // Always start native ring here; handleIncomingCallNative stops it only on the
                    // true in-app foreground path. Gating on isHostResumed missed some Samsung / FCM
                    // states where the activity was not resumed but ring was skipped anyway.
                    startIncomingCallRingtone(inviteForRing);
                    handleIncomingCallNative(appData);
                }
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

    private void emitCallFlowNative(String stage, String inviteId, JSONObject extra) {
        try {
            JSONObject o = new JSONObject();
            o.put("tag", "CALL_FLOW");
            o.put("stage", stage);
            o.put("ts", System.currentTimeMillis());
            o.put("inviteId", inviteId != null && !inviteId.isEmpty() ? inviteId : JSONObject.NULL);
            o.put("source", "android_native");
            RunningAppProcessInfo pinfo = new RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(pinfo);
            o.put("procImportance", pinfo.importance);
            if (extra != null) {
                Iterator<String> it = extra.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    o.put(k, extra.opt(k));
                }
            }
            Log.i(CALL_FLOW_TAG, o.toString());
        } catch (Exception e) {
            Log.w(TAG, "emitCallFlowNative failed: " + e.getMessage());
        }
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
        if (!appInForeground) {
            // Side-effect: logs launcher / lock context for diagnostics.
            shouldUseFullScreenUi();
        }
        // Multi-call: if the user already has an active call, route this
        // INVITE to the JS layer as a "foreground" event regardless of the
        // process/activity state. The JS CallSessionManager + CallWaitingBanner
        // take over from here; the native full-screen intent is suppressed.
        String presentationMode;
        if (inActiveCall) {
            presentationMode = PRESENTATION_FOREGROUND_JS;
            Log.i(TAG, "[MULTICALL] presentation overridden to FOREGROUND_JS — in_active_call=true");
        } else {
            presentationMode = appInForeground
                ? PRESENTATION_FOREGROUND_JS
                : PRESENTATION_FULL_SCREEN;
        }

        try {
            JSONObject h = new JSONObject();
            h.put("presentation", presentationMode);
            h.put("appInForeground", appInForeground);
            emitCallFlowNative("NATIVE_INCOMING_HANDLER_ENTER", inviteId, h);
        } catch (Exception ignored) {
        }

        Log.i(TAG, "[LOCK_CALL_NATIVE] incoming_received inviteId=" + inviteId + " from=" + fromNum + " presentation=" + presentationMode + " appInForeground=" + appInForeground);
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
            // When the React host is foreground, dispatch a DeviceEventEmitter
            // event so JS can mount IncomingCallScreen immediately — we cannot
            // rely on JsSIP's `newRTCSession` signal to drive the UI because
            // the WSS socket can be stale after the app returned from the
            // background (INVITE gets dropped server-side while the push still
            // reaches us reliably).
            try {
                com.facebook.react.bridge.WritableMap p = Arguments.createMap();
                p.putString("inviteId", inviteId == null ? "" : inviteId);
                p.putString("callId", data.get("callId") == null ? (inviteId == null ? "" : inviteId) : data.get("callId"));
                p.putString("fromNumber", fromNum == null ? "" : fromNum);
                p.putString("fromDisplay", fromDisp == null ? "" : fromDisp);
                p.putString("toExtension", data.get("toExtension") == null ? "" : data.get("toExtension"));
                p.putString("pbxCallId", data.get("pbxCallId") == null ? "" : data.get("pbxCallId"));
                p.putString("tenantId", data.get("tenantId") == null ? "" : data.get("tenantId"));
                p.putString("sipCallTarget", data.get("sipCallTarget") == null ? "" : data.get("sipCallTarget"));
                p.putString("pbxSipUsername", data.get("pbxSipUsername") == null ? "" : data.get("pbxSipUsername"));
                p.putString("timestamp", data.get("timestamp") == null ? "" : data.get("timestamp"));
                p.putDouble("pushReceivedAt", (double) System.currentTimeMillis());
                IncomingCallUiModule.emitForegroundInvite(p);
            } catch (Exception e) {
                Log.w(TAG, "[CALL_INCOMING] emitForegroundInvite failed: " + e.getMessage());
            }
            // Native ringtone keeps playing. JS no longer layers expo-av on top
            // (that caused the lock-screen double-ringtone). The native ringtone
            // is stopped exclusively via: intent_answer/decline onNewIntent,
            // handleCallTerminationNative (INVITE_CLAIMED / CANCELED / MISSED),
            // or the IncomingCallUi.dismiss / stopRingtone JS bridge.
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
        // When we reach native UI, the app was not in the React foreground path — prefer a
        // full-screen launch on all supported API levels so home / recent-task states still
        // get the incoming surface (heads-up alone is easy to miss on OEMs).
        launchIncomingCallUi(data, inviteId, displayName, fromNum, true);
    }

    private void handleCallTerminationNative(String type, Map<String, String> data) {
        String inviteId = data.get("inviteId");
        if (inviteId == null || inviteId.isEmpty()) inviteId = data.get("callId");
        Log.i(TAG, "[LOCK_CALL_CLEANUP] native_termination type=" + type + " inviteId=" + inviteId);
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
        // Notification sound is owned by the channel (v4+). Avoid NotificationCompat.setSound
        // with AudioAttributes here — older androidx resolves the (Uri, int) overload only.

        NotificationManagerCompat.from(this).notify(notificationId, builder.build());
        try {
            JSONObject n = new JSONObject();
            n.put("preferFullScreen", preferFullScreen);
            emitCallFlowNative("NATIVE_NOTIFICATION_POSTED", inviteId, n);
        } catch (Exception ignored) {
        }
        Log.i(TAG, "[CALL_INCOMING] posted incoming call notification mode=" + (preferFullScreen ? "full_screen" : "heads_up"));
        if (preferFullScreen) {
            triggerFullScreenIntent(fullScreenIntent, launchIntent);
        }
    }

    private void triggerFullScreenIntent(PendingIntent fullScreenIntent, Intent launchIntent) {
        // Force the display ON before launching the activity. MainActivity has
        // android:showWhenLocked="true" + android:turnScreenOn="true" declared
        // statically in the manifest (the runtime setShowWhenLocked(true) /
        // setTurnScreenOn(true) path was unreliable after the first call
        // because onNewIntent on a paused-behind-keyguard activity did not
        // actually surface the window). The manifest attributes handle window
        // placement above the keyguard, and this wake lock forces the display
        // backlight on so the user can actually see the UI.
        acquireIncomingScreenWakeLock();
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
            Log.i(TAG, "[LOCK_CALL_NATIVE] full_screen_intent_sent");
            Log.i(TAG, "[CALL_INCOMING] requested branded full-screen launch via pending intent");
        } catch (Exception e) {
            Log.w(TAG, "[LOCK_CALL_NATIVE] full_screen_intent_send_failed: " + e.getMessage());
            Log.w(TAG, "[CALL_INCOMING] full-screen pending intent launch failed: " + e.getMessage());
        }
    }

    /**
     * Brief screen-on wake lock. Lives for a few seconds — long enough for the
     * KeyguardManager to surface MainActivity (setShowWhenLocked applied via
     * applyIncomingCallWindowFlags during onNewIntent) so the user actually
     * sees the incoming call UI on lock screen. Released by
     * {@link #releaseIncomingScreenWakeLock()} on ringtone stop.
     */
    private void acquireIncomingScreenWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            synchronized (IncomingCallFirebaseService.class) {
                if (incomingScreenWakeLock != null && incomingScreenWakeLock.isHeld()) {
                    incomingScreenWakeLock.release();
                }
                // SCREEN_BRIGHT_WAKE_LOCK is formally deprecated but remains the
                // only reliable way to force the AMOLED on from a background
                // service. ACQUIRE_CAUSES_WAKEUP = turn screen on NOW. Short
                // timeout so we never leak a bright display.
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                    "Connect:IncomingCallScreen"
                );
                wl.setReferenceCounted(false);
                wl.acquire(15_000L);
                incomingScreenWakeLock = wl;
                Log.i(TAG, "[CALL_INCOMING] acquired SCREEN_BRIGHT wake lock for full-screen launch");
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] acquireIncomingScreenWakeLock: " + e.getMessage());
        }
    }

    private static void releaseIncomingScreenWakeLock() {
        try {
            synchronized (IncomingCallFirebaseService.class) {
                if (incomingScreenWakeLock != null && incomingScreenWakeLock.isHeld()) {
                    incomingScreenWakeLock.release();
                }
                incomingScreenWakeLock = null;
            }
        } catch (Exception ignored) {
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
        // Ring audio is owned exclusively by startIncomingCallRingtone() (R.raw + MediaPlayer fallback).
        // A channel default sound here fights that path and users hear the wrong system ring.
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

    /**
     * Schedules an auto-dismiss watchdog tied to the current invite. If nothing
     * else stops the ringtone within {@link #INCOMING_CALL_TIMEOUT_MS}, the
     * watchdog fires {@link #dismissIncomingCallUi} with a synthetic reason so
     * the stream state is consistent across logs, telemetry, and the cache
     * file. Safe to call repeatedly — each call cancels any previous pending
     * timeout first.
     */
    private void scheduleRingtoneTimeout(final String inviteId) {
        if (mainHandler == null) {
            synchronized (IncomingCallFirebaseService.class) {
                if (mainHandler == null) {
                    mainHandler = new Handler(Looper.getMainLooper());
                }
            }
        }
        cancelRingtoneTimeout();
        final Context appCtx = getApplicationContext();
        final String inviteSnapshot = inviteId;
        Runnable r = new Runnable() {
            @Override
            public void run() {
                pendingRingtoneTimeout = null;
                // Only fire if this invite is still the active one — avoids
                // racing with a newer call that replaced the ringtone.
                if (inviteSnapshot != null && inviteSnapshot.equals(lastRingtoneInviteId)) {
                    Log.w(
                        TAG,
                        "[CALL_INCOMING] watchdog timed out inviteId=" + inviteSnapshot
                            + " — forcing dismissIncomingCallUi"
                    );
                    dismissIncomingCallUi(appCtx, inviteSnapshot, "watchdog_timeout");
                    deleteCacheFileStatic(appCtx);
                }
            }
        };
        pendingRingtoneTimeout = r;
        mainHandler.postDelayed(r, INCOMING_CALL_TIMEOUT_MS);
    }

    private static void cancelRingtoneTimeout() {
        Runnable r = pendingRingtoneTimeout;
        if (r != null && mainHandler != null) {
            mainHandler.removeCallbacks(r);
        }
        pendingRingtoneTimeout = null;
    }

    private static void deleteCacheFileStatic(Context context) {
        try {
            File file = new File(context.getCacheDir(), CACHE_FILE);
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "[CALL_INCOMING] watchdog failed to delete cache file");
            }
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] watchdog deleteCacheFileStatic failed: " + e.getMessage());
        }
    }

    /**
     * Play the bundled incoming-call ringtone so it is volumed / routed as a
     * real ringtone (Ring/Notification slider) — NOT as media.
     *
     * Why not {@code MediaPlayer.create(ctx, resId)}?
     *   The static helper calls {@code prepare()} internally with the legacy
     *   stream type defaulted to {@code STREAM_MUSIC}. Calling
     *   {@code setAudioAttributes()} AFTER the player has been prepared is a
     *   no-op on many Android builds for the purposes of stream routing, so
     *   the phone's Media slider ended up controlling the ringtone volume
     *   and ducking was based on music policy — which is exactly the bug
     *   the user reported ("ringtone behaves like a music track").
     *
     * The fix below builds the player manually and sets
     * {@link AudioAttributes} with:
     *   • {@code USAGE_NOTIFICATION_RINGTONE}
     *   • {@code CONTENT_TYPE_SONIFICATION}
     *   • Legacy stream type {@code STREAM_RING}
     * BEFORE calling {@code setDataSource()} and {@code prepare()}. This
     * guarantees the audio flinger routes playback through the Ring/
     * Notification stream and respects Do Not Disturb / silent mode like a
     * proper incoming call.
     */
    private synchronized void startIncomingCallRingtone(String inviteIdForRing) {
        stopIncomingCallRingtone("restart_before_new_call");
        AssetFileDescriptor afd = null;
        try {
            requestRingtoneAudioFocus();
            Context appCtx = getApplicationContext();

            MediaPlayer player = new MediaPlayer();

            // Build AudioAttributes FIRST so setDataSource() / prepare() use
            // the correct stream. USAGE_NOTIFICATION_RINGTONE + SONIFICATION
            // content routes the track through STREAM_RING on every
            // supported API level.
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setLegacyStreamType(AudioManager.STREAM_RING)
                .build();
            player.setAudioAttributes(attrs);

            // Older devices ignore AudioAttributes for volume mapping — keep
            // setAudioStreamType as a belt-and-suspenders hint. Must be
            // called before prepare().
            try {
                player.setAudioStreamType(AudioManager.STREAM_RING);
            } catch (IllegalStateException ignored) { /* some OEMs throw once attrs are set */ }

            afd = appCtx.getResources().openRawResourceFd(R.raw.connect_default_ringtone);
            if (afd == null) {
                Log.w(TAG, "[CALL_INCOMING] openRawResourceFd returned null — falling back to system default ringtone");
                try { player.release(); } catch (Exception ignored) { }
                startSystemDefaultRingtoneFallback(inviteIdForRing);
                return;
            }
            player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            player.prepare();

            player.setLooping(true);
            // Relative volume — actual loudness follows STREAM_RING so the
            // user's ring/notification slider controls how loud this is.
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
            lastRingtoneInviteId = inviteIdForRing;
            ringtoneStartedAtMs = System.currentTimeMillis();
            ringtoneSource = "media_player";
            ringtoneStoppedAtMs = 0;
            ringtoneStopReason = null;
            try {
                JSONObject r = new JSONObject();
                r.put("path", "media_player");
                r.put("stream", "STREAM_RING");
                emitCallFlowNative("RINGTONE_START", inviteIdForRing, r);
            } catch (Exception ignored) {
            }
            Log.i(TAG, "[CALL_INCOMING] native ringtone playback started (media_player on STREAM_RING)");
            scheduleRingtoneTimeout(inviteIdForRing);
        } catch (IOException | IllegalArgumentException | IllegalStateException e) {
            Log.w(TAG, "[CALL_INCOMING] startIncomingCallRingtone failed: " + e.getMessage());
            startSystemDefaultRingtoneFallback(inviteIdForRing);
        } catch (Exception e) {
            Log.w(TAG, "[CALL_INCOMING] startIncomingCallRingtone unexpected failure: " + e.getMessage());
            startSystemDefaultRingtoneFallback(inviteIdForRing);
        } finally {
            if (afd != null) {
                try { afd.close(); } catch (Exception ignored) { }
            }
        }
    }

    private void startSystemDefaultRingtoneFallback(String inviteIdForRing) {
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
                        .setLegacyStreamType(AudioManager.STREAM_RING)
                        .build()
                );
                rt.setLooping(true);
            } else {
                // Pre-P RingtoneManager ignores AudioAttributes — best we can
                // do is force the legacy stream type so volume follows the
                // ring slider.
                try { rt.setStreamType(AudioManager.STREAM_RING); } catch (Exception ignored) { }
            }
            rt.play();
            systemRingtoneFallback = rt;
            acquireIncomingRingWakeLock();
            lastRingtoneInviteId = inviteIdForRing;
            ringtoneStartedAtMs = System.currentTimeMillis();
            ringtoneSource = "system_fallback";
            ringtoneStoppedAtMs = 0;
            ringtoneStopReason = null;
            try {
                JSONObject r = new JSONObject();
                r.put("path", "system_fallback");
                emitCallFlowNative("RINGTONE_START", inviteIdForRing, r);
            } catch (Exception ignored) {
            }
            Log.i(TAG, "[CALL_INCOMING] native ringtone playback started (system_fallback)");
            scheduleRingtoneTimeout(inviteIdForRing);
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
        stopIncomingCallRingtone("unspecified", null);
    }

    public static synchronized void stopIncomingCallRingtone(String reason) {
        stopIncomingCallRingtone(reason, null);
    }

    /**
     * Stops native ringtone playback. {@code inviteIdForLog} is used only for ConnectCallFlow JSON
     * when JS dismisses before/without {@link #lastRingtoneInviteId} (e.g. deep link / no FCM ring).
     */
    public static synchronized void stopIncomingCallRingtone(String reason, String inviteIdForLog) {
        cancelRingtoneTimeout();
        try {
            String effectiveInvite = (inviteIdForLog != null && !inviteIdForLog.isEmpty())
                ? inviteIdForLog
                : lastRingtoneInviteId;
            JSONObject o = new JSONObject();
            o.put("tag", "CALL_FLOW");
            o.put("stage", "RINGTONE_STOP");
            o.put("ts", System.currentTimeMillis());
            o.put("inviteId", effectiveInvite != null ? effectiveInvite : JSONObject.NULL);
            o.put("source", "android_native");
            o.put("reason", reason);
            RunningAppProcessInfo pinfo = new RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(pinfo);
            o.put("procImportance", pinfo.importance);
            Log.i(CALL_FLOW_TAG, o.toString());
        } catch (Exception ignored) {
        }
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
        releaseIncomingScreenWakeLock();
        abandonRingtoneAudioFocus();
        // Record stop time for flight recorder JS read-back
        if (ringtoneStartedAtMs > 0 && ringtoneStoppedAtMs == 0) {
            ringtoneStoppedAtMs = System.currentTimeMillis();
            ringtoneStopReason = reason;
        }
        lastRingtoneInviteId = null;
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
        stopIncomingCallRingtone(reason, inviteId);
        // The cache file is the "is there a pending call?" breadcrumb JS reads on
        // cold start. Leaving it around after dismiss is the root cause of the
        // Samsung Recents / back-button loop: Android re-launches MainActivity
        // with the original VIEW deep-link as the task's baseIntent, JS re-reads
        // the cache file, shows IncomingCallScreen, polls, sees hungup, shows
        // Call Ended, user presses back, Recents re-launches → loop.
        deleteCacheFileStatic(context);
        Log.i(TAG, "[CALL_INCOMING] dismissed incoming ui inviteId=" + inviteId + " reason=" + reason);
    }

    /**
     * Returns true if the native service still has a live incoming-call breadcrumb
     * (cache file present). Used by {@link MainActivity} to distinguish a fresh
     * full-screen-intent launch from a Recents/launcher re-replay of the task's
     * baseIntent after the call already ended.
     */
    public static boolean hasPendingIncomingCall(Context context) {
        try {
            File file = new File(context.getCacheDir(), CACHE_FILE);
            return file.exists();
        } catch (Exception e) {
            return false;
        }
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
        // Do NOT stop the ringtone here. FCM tears this service down right after
        // onMessageReceived(); stopping audio in onDestroy made home-screen rings silent.
        Log.i(TAG, "[CALL_INCOMING] service onDestroy (ringtone left to dismissIncomingCallUi / JS)");
        super.onDestroy();
    }

    private static void appendQueryParameter(Uri.Builder builder, String key, String value) {
        if (value != null && !value.isEmpty()) {
            builder.appendQueryParameter(key, value);
        }
    }
}
