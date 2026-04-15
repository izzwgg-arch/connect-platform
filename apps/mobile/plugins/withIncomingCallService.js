/**
 * withIncomingCallService.js
 *
 * Expo config plugin that injects a native Android Java service:
 *   IncomingCallFirebaseService extends ExpoFirebaseMessagingService
 *
 * This service receives FCM data messages directly in Java (onMessageReceived),
 * detects INCOMING_CALL payloads, and calls TelecomManager.addNewIncomingCall()
 * WITHOUT waiting for JavaScript to start. This bypasses Samsung Freecess
 * process-freezing delays that prevent the JS background task from firing in time.
 *
 * Flow:
 *   FCM high-priority data message
 *     → IncomingCallFirebaseService.onMessageReceived()  [JAVA, ~100ms]
 *         → writes call data to <cacheDir>/pending_call_native.json
 *         → TelecomManager.addNewIncomingCall()           [native call UI shown]
 *         → super.onMessageReceived()                    [Expo still schedules BG task]
 *     → (later) JS background task runs                  [writes AsyncStorage, skips duplicate CallKeep]
 *     → User answers → app starts → reads cache file or AsyncStorage → SIP connects
 */

const { withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('expo/config-plugins');
const path = require('path');
const fs = require('fs');

const APP_PACKAGE = 'com.connectcommunications.mobile';
const SERVICE_CLASS_SHORT = 'IncomingCallFirebaseService';
const SERVICE_CLASS_FULL = `${APP_PACKAGE}.${SERVICE_CLASS_SHORT}`;
const EXPO_FCM_SERVICE = 'expo.modules.notifications.service.ExpoFirebaseMessagingService';
const RINGTONE_SOURCE = path.join(__dirname, '..', 'assets', 'connect-default-ringtone.mp4');
const RINGTONE_RESOURCE_NAME = 'connect_default_ringtone.mp4';

// ---------------------------------------------------------------------------
// Java source for the native FCM handler
// ---------------------------------------------------------------------------
function getJavaSource() {
    return fs.readFileSync(path.join(__dirname, 'IncomingCallFirebaseService.java'), 'utf8');
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Step 1: write IncomingCallFirebaseService.java into the generated Android project.
 */
function withJavaFile(config) {
    return withDangerousMod(config, [
        'android',
        async (c) => {
            const { platformProjectRoot } = c.modRequest;
            const javaDir = path.join(
                platformProjectRoot,
                'app', 'src', 'main', 'java',
                'com', 'connectcommunications', 'mobile'
            );
            fs.mkdirSync(javaDir, { recursive: true });
            const dest = path.join(javaDir, `${SERVICE_CLASS_SHORT}.java`);
            fs.writeFileSync(dest, getJavaSource(), 'utf8');
            console.log(`[withIncomingCallService] wrote ${dest}`);
            return c;
        },
    ]);
}

function withRingtoneResource(config) {
    return withDangerousMod(config, [
        'android',
        async (c) => {
            const { platformProjectRoot } = c.modRequest;
            const rawDir = path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'raw');
            fs.mkdirSync(rawDir, { recursive: true });
            const dest = path.join(rawDir, RINGTONE_RESOURCE_NAME);
            fs.copyFileSync(RINGTONE_SOURCE, dest);
            console.log(`[withIncomingCallService] copied ringtone resource to ${dest}`);
            return c;
        },
    ]);
}

/**
 * Step 2: Update AndroidManifest.xml.
 *
 * - Add IncomingCallFirebaseService with com.google.firebase.MESSAGING_EVENT
 * - Add a tools:node="remove" stub for ExpoFirebaseMessagingService so the
 *   Gradle manifest merger strips it out. This prevents two competing services
 *   from both registering for MESSAGING_EVENT.
 * - Ensure xmlns:tools is declared on the manifest root.
 */
function withManifest(config) {
    return withAndroidManifest(config, (mod) => {
        const manifest = mod.modResults.manifest;
        const app = manifest.application?.[0];
        if (!app) return mod;

        // Ensure xmlns:tools is declared on the manifest root for tools:node usage.
        if (!manifest.$['xmlns:tools']) {
            manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
        }

        const services = app.service ?? [];

        // Add our native FCM handler service (only once).
        const alreadyAdded = services.some((s) => s.$?.['android:name'] === SERVICE_CLASS_FULL);
        if (!alreadyAdded) {
            services.push({
                $: {
                    'android:name': SERVICE_CLASS_FULL,
                    'android:exported': 'false',
                },
                'intent-filter': [
                    {
                        action: [
                            { $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } },
                        ],
                    },
                ],
            });
            console.log(`[withIncomingCallService] added ${SERVICE_CLASS_FULL}`);
        }

        // Add a tools:node="remove" entry for ExpoFirebaseMessagingService so the
        // Gradle manifest merger removes it from the final merged manifest. This
        // prevents the two services from competing for MESSAGING_EVENT.
        const removeAlreadyAdded = services.some(
            (s) => s.$?.['android:name'] === EXPO_FCM_SERVICE && s.$?.['tools:node'] === 'remove'
        );
        if (!removeAlreadyAdded) {
            services.push({
                $: {
                    'android:name': EXPO_FCM_SERVICE,
                    'tools:node': 'remove',
                },
            });
            console.log(`[withIncomingCallService] added tools:node=remove for ${EXPO_FCM_SERVICE}`);
        }

        app.service = services;
        return mod;
    });
}

/**
 * Step 3: Add Firebase messaging as an explicit compile dependency to the app
 * module so IncomingCallFirebaseService.java can reference Firebase classes.
 *
 * Firebase messaging is a transitive `implementation` dependency of
 * expo-notifications but is NOT exposed to the app module's compile classpath,
 * causing "cannot find symbol: class FirebaseMessagingService" errors.
 */
function withFirebaseDependency(config) {
    return withAppBuildGradle(config, (mod) => {
        const content = mod.modResults.contents;
        const marker = 'implementation("com.google.firebase:firebase-messaging")';
        if (content.includes(marker)) {
            return mod; // already present, no-op
        }
        // Find the last `dependencies {` block and append our line just before its closing `}`.
        // build.gradle has nested braces (android { ... defaultConfig { ... } }) so we walk
        // character by character to find the right closing brace rather than using a fragile regex.
        const depsIdx = content.lastIndexOf('dependencies {');
        if (depsIdx === -1) {
            // Fallback: just append a new block at the end of the file.
            mod.modResults.contents = content.trimEnd() + `\ndependencies {\n    ${marker}\n}\n`;
            console.log('[withIncomingCallService] appended new dependencies block with firebase-messaging');
            return mod;
        }
        // Walk forward from `dependencies {` to find the matching `}`.
        let depth = 0;
        let closeIdx = -1;
        for (let i = depsIdx; i < content.length; i++) {
            if (content[i] === '{') depth++;
            else if (content[i] === '}') {
                depth--;
                if (depth === 0) { closeIdx = i; break; }
            }
        }
        if (closeIdx === -1) {
            console.warn('[withIncomingCallService] could not find closing brace for dependencies block — skipping');
            return mod;
        }
        // Insert the line just before the closing brace.
        mod.modResults.contents =
            content.slice(0, closeIdx) +
            `    ${marker}\n` +
            content.slice(closeIdx);
        console.log('[withIncomingCallService] added firebase-messaging dependency to app/build.gradle');
        return mod;
    });
}

module.exports = function withIncomingCallService(config) {
    config = withJavaFile(config);
    config = withRingtoneResource(config);
    config = withManifest(config);
    config = withFirebaseDependency(config);
    return config;
};
