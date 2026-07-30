import type { ExpoConfig } from 'expo/config';
import type { ConfigPlugin } from 'expo/config-plugins';
import { withAndroidManifest } from 'expo/config-plugins';

// Adds the VoiceConnectionService required by react-native-callkeep.
// Without android:permission="BIND_TELECOM_CONNECTION_SERVICE" Android throws
// a SecurityException when registerPhoneAccount() is called, crashing the app.
const withCallKeepManifest: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (!app) return mod;

    const services: any[] = app.service ?? [];
    const serviceClass = 'io.wazo.callkeep.VoiceConnectionService';
    const alreadyAdded = services.some(
      (s) => s.$?.['android:name'] === serviceClass
    );

    if (!alreadyAdded) {
      services.push({
        $: {
          'android:name': serviceClass,
          'android:label': 'Calls',
          'android:permission': 'android.permission.BIND_TELECOM_CONNECTION_SERVICE',
          'android:exported': 'true',
          'android:foregroundServiceType': 'phoneCall',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.telecom.ConnectionService' } }],
          },
        ],
      });
      app.service = services;
    }
    return mod;
  });

function resolveProfile(): string {
  return String(process.env.EAS_BUILD_PROFILE || process.env.EXPO_BUILD_PROFILE || 'dev').toLowerCase();
}

const profile = resolveProfile();
const isProdProfile = profile === 'production';
// Dev-client builds only: the phone must fetch the JS bundle from Metro over
// plain http (LAN or Tailscale IP), which iOS ATS blocks by default. Never on
// for preview/production.
const isDevClientProfile = profile === 'dev' || profile === 'ios-dev-device';
const requestedVoiceSimulate = String(process.env.EXPO_PUBLIC_VOICE_SIMULATE || 'false').toLowerCase() === 'true';
const voiceSimulate = isProdProfile ? false : requestedVoiceSimulate;
const logLevel = (process.env.EXPO_PUBLIC_LOG_LEVEL || (isProdProfile ? 'warn' : profile === 'preview' ? 'info' : 'debug')).toLowerCase();
const easProjectId = '53c72ced-180c-4885-a3ff-7d5da5717ead';
const appVersion = '1.0.0';
const runtimeVersion = process.env.SHIP_BUILD_ID ? `${appVersion}+${process.env.SHIP_BUILD_ID}` : appVersion;

const config: ExpoConfig = {
  name: 'Connect',
  slug: 'connect-mobile',
  owner: 'izz8457s-organization',
  version: appVersion,
  runtimeVersion,
  // OTA updates are DISABLED by owner directive — the app must always run the
  // JS bundle embedded in the APK, never a downloaded update. This prevents a
  // stale cached OTA from shadowing the shipped bundle (observed 2026-07-01,
  // where a cached OTA overrode a freshly-built embedded fix). Ship code only
  // via a new build, never via expo-updates.
  updates: {
    enabled: false,
  },
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  backgroundColor: '#040810',

  // ── App icon (1024×1024, no rounded corners — OS clips to shape) ──────────
  icon: './assets/icon.png',

  // ── Native splash — shown by Expo before JS bundle is ready ───────────────
  // The in-app SplashScreen component takes over immediately after JS loads.
  splash: {
    image: './assets/splash.png',
    backgroundColor: '#040810',
    resizeMode: 'cover',
  },

  ios: {
    supportsTablet: false,
    // Bumped per build so an ad-hoc install cleanly REPLACES the prior build
    // on-device. iOS can skip swapping the binary when CFBundleVersion is
    // unchanged, which looks like "nothing changed" after reinstalling.
    buildNumber: '20',
    bundleIdentifier: 'com.connectcommunications.mobile',
    infoPlist: {
      NSCameraUsageDescription: 'Camera access is required to scan PBX provisioning QR codes.',
      NSMicrophoneUsageDescription: 'Microphone access is required for voice calls.',
      NSContactsUsageDescription:
        'Connect needs access to your phone contacts so you can import them into the app and call them quickly.',
      UIBackgroundModes: ['voip', 'remote-notification', 'audio'],
      // App Store compliance: encryption export declaration. The app uses only
      // standard HTTPS/TLS and OS-provided crypto (exempt), so this is false and
      // avoids the manual "export compliance" prompt on every TestFlight/App
      // Store build. If custom/non-exempt encryption is ever added, revisit this.
      ITSAppUsesNonExemptEncryption: false,
      ...(isDevClientProfile
        ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }
        : {}),
    },
    // App Store compliance: privacy manifest (required by Apple for apps that use
    // "required reason" APIs). Covers the common APIs pulled in by Expo/RN.
    // NSPrivacyTracking=false and empty tracking domains: the app does not track.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: ['E174.1'],
        },
      ],
    },
  },
  android: {
    package: 'com.connectcommunications.mobile',
    backgroundColor: '#040810',
    // google-services.json provides the Firebase/FCM configuration used by
    // expo-notifications to obtain Expo push tokens on Android.
    // Without this, Firebase fails to initialize ("Default FirebaseApp is not initialized").
    googleServicesFile: './google-services.json',
    // Adaptive icon: foreground is the icon image, background is the gradient base colour.
    // This gives proper Android 8+ adaptive icon behaviour (circle, squircle, etc).
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#1d4ed8',
    },
    minSdkVersion: 24,
      permissions: [
        'CAMERA',
        'RECORD_AUDIO',
        'MODIFY_AUDIO_SETTINGS',
        'BLUETOOTH',
        'BLUETOOTH_CONNECT',
        'POST_NOTIFICATIONS',
        'FOREGROUND_SERVICE',
        'VIBRATE',
        'USE_FULL_SCREEN_INTENT',
        'MANAGE_OWN_CALLS',
        'READ_PHONE_STATE',
        'FOREGROUND_SERVICE_PHONE_CALL',
        // Allows CallKeep to restore state after device reboot
        'RECEIVE_BOOT_COMPLETED',
        // Required by expo-task-manager for background processing
        'WAKE_LOCK',
        // Required for the battery optimization settings intent
        // (android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).
        // Without this declaration Android rejects the intent with SecurityException.
        'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        // expo-contacts — required to read the device address book during
        // an *explicit* user-initiated import. The plugin block below also
        // adds NSContactsUsageDescription on iOS.
        'READ_CONTACTS',
        // Mirror newly-created Connect contacts into the device address book
        // (primary Google account) so they back up & sync like WhatsApp.
        'WRITE_CONTACTS',
      ],
  },
  extra: {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    voiceSimulate,
    logLevel,
    buildProfile: profile,
    easProjectId,
    /** When true, release builds show the DBG call-flow overlay (same as __DEV__). */
    callFlowDebugOverlay:
      String(process.env.EXPO_PUBLIC_CALL_FLOW_DEBUG_OVERLAY || '').toLowerCase() === 'true',
    eas: {
      projectId: easProjectId,
    },
  },
  plugins: [
    withCallKeepManifest,
    './plugins/withIncomingCallService',
    // iOS VoIP push wiring (PushKit → RNVoipPushNotificationManager).
    // No-op on Android. See plugins/withIosVoipPush.js for the full contract
    // and post-prebuild checklist (Apple VoIP cert, worker APNs VoIP path).
    './plugins/withIosVoipPush',
    // iOS-only: bundles a silent WAV CallKit can use as its own ringtoneSound
    // so "Connect Default" ringtone preference doesn't double up with
    // CallKit's native ring. See plugins/withIosSilentRingtone.js.
    './plugins/withIosSilentRingtone',
    // iOS-only: bundles the REAL Connect ringtone (.caf) so CallKit itself
    // plays it in the background/killed case (JS not running). RNCallKeep
    // persists it to NSUserDefaults so cold launches read it. See
    // plugins/withIosConnectRingtone.js.
    './plugins/withIosConnectRingtone',
    'expo-secure-store',
    'expo-task-manager',
    [
      'expo-notifications',
      {
        // Notification icon shown in the Android status bar — monochrome white PNG.
        // Falls back to the app icon if this asset doesn't exist.
        icon: './assets/notification-icon.png',
        color: '#1d4ed8',
        // Pre-configure the high-importance Telecom/call channel so it exists
        // even before the JS runtime calls setNotificationChannelAsync().
        // This matters for the first push arriving on a fresh install.
        androidChannels: [
          {
            name: 'Incoming Calls',
            importance: 5, // IMPORTANCE_HIGH (MAX on Android)
            vibrationPattern: [0, 500, 200, 500],
            lockScreenVisibility: 1, // VISIBILITY_PUBLIC — shown on lock screen
            enableVibrate: true,
            enableLights: true,
            lightColor: '#22c55e',
            showBadge: false,
            id: 'connect-calls',
            sound: 'default',
            bypassDnd: false,
          },
          {
            id: 'connect-messages',
            name: 'Messages',
            importance: 4,
            vibrationPattern: [0, 160],
            lockScreenVisibility: 0,
            enableVibrate: true,
            enableLights: true,
            lightColor: '#1d4ed8',
            showBadge: true,
            sound: 'default',
          },
          {
            id: 'connect-voicemail',
            name: 'Voicemail',
            importance: 4,
            vibrationPattern: [0, 220, 120, 220],
            lockScreenVisibility: 0,
            enableVibrate: true,
            enableLights: true,
            lightColor: '#06b6d4',
            showBadge: true,
            sound: 'default',
          },
          {
            id: 'connect-missed-calls',
            name: 'Missed Calls',
            importance: 4,
            vibrationPattern: [0, 300, 120, 300],
            lockScreenVisibility: 0,
            enableVibrate: true,
            enableLights: true,
            lightColor: '#f97316',
            showBadge: true,
            sound: 'default',
          },
        ],
      },
    ],
    'expo-dev-client',
    [
      'expo-camera',
      {
        cameraPermission: 'Allow Connect to scan provisioning QR codes.',
      },
    ],
    [
      'expo-contacts',
      {
        contactsPermission:
          'Allow Connect to access your phone contacts so you can import them into the app and call them quickly.',
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 24,
          extraProguardRules: [
            '-keep class com.oney.WebRTCModule.** { *; }',
            '-keep class org.webrtc.** { *; }',
            '-keep class com.twilio.** { *; }',
            '-dontwarn org.webrtc.**',
          ].join('\n'),
        },
      },
    ],
  ],
};

export default config;
