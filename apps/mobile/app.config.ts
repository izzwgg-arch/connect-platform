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

const config: ExpoConfig = {
  name: 'Connect',
  slug: 'connect-mobile',
  owner: 'izz8457s-organization',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  backgroundColor: '#090e18',
  splash: {
    backgroundColor: '#090e18',
    resizeMode: 'contain',
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
    backgroundColor: '#090e18',
    minSdkVersion: 24,
      permissions: [
        'CAMERA',
        'RECORD_AUDIO',
        'MODIFY_AUDIO_SETTINGS',
        'POST_NOTIFICATIONS',
        'FOREGROUND_SERVICE',
        'VIBRATE',
        'USE_FULL_SCREEN_INTENT',
        'MANAGE_OWN_CALLS',
        'READ_PHONE_STATE',
        'FOREGROUND_SERVICE_PHONE_CALL',
      ],
  },
  extra: {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    voiceSimulate,
    logLevel,
    buildProfile: profile,
    easProjectId: '53c72ced-180c-4885-a3ff-7d5da5717ead',
    eas: {
      projectId: '53c72ced-180c-4885-a3ff-7d5da5717ead',
    },
  },
  plugins: [
    withCallKeepManifest,
    'expo-secure-store',
    'expo-notifications',
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
