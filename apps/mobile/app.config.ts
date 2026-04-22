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
const requestedVoiceSimulate = String(process.env.EXPO_PUBLIC_VOICE_SIMULATE || 'false').toLowerCase() === 'true';
const voiceSimulate = isProdProfile ? false : requestedVoiceSimulate;
const logLevel = (process.env.EXPO_PUBLIC_LOG_LEVEL || (isProdProfile ? 'warn' : profile === 'preview' ? 'info' : 'debug')).toLowerCase();
const easProjectId = '53c72ced-180c-4885-a3ff-7d5da5717ead';
const appVersion = '1.0.0';

const config: ExpoConfig = {
  name: 'Connect',
  slug: 'connect-mobile',
  owner: 'izz8457s-organization',
  version: appVersion,
  runtimeVersion: appVersion,
  updates: {
    enabled: true,
    url: `https://u.expo.dev/${easProjectId}`,
    checkAutomatically: 'ON_ERROR_RECOVERY',
    fallbackToCacheTimeout: 0,
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
    bundleIdentifier: 'com.connectcommunications.mobile',
    infoPlist: {
      NSCameraUsageDescription: 'Camera access is required to scan PBX provisioning QR codes.',
      NSMicrophoneUsageDescription: 'Microphone access is required for voice calls.',
      UIBackgroundModes: ['voip', 'remote-notification', 'audio'],
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
