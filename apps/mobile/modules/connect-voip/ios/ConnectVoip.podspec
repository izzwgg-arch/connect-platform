require 'json'

# Local Expo module hosting the Connect VoIP PushKit handler.
#
# SDK 54 migration (2026-07-30): Expo now generates a SWIFT AppDelegate, so the
# old string-patch approach in plugins/withIosVoipPush.js (which patched the
# Objective-C++ AppDelegate.mm) can no longer carry the PushKit wiring. The
# battle-tested ObjC++ code moved VERBATIM into ConnectVoipPushHandler.mm here;
# ConnectVoipAppDelegateSubscriber installs it at app launch via Expo's
# AppDelegateSubscriber mechanism. Behavior contract unchanged — see the
# handler file for the full history (cold-kill ring, cancel pushes, caller-ID
# cache, audio-mode guardian).

Pod::Spec.new do |s|
  s.name           = 'ConnectVoip'
  s.version        = '1.0.0'
  s.summary        = 'Connect VoIP PushKit + CallKit native glue'
  s.description    = 'PushKit registration, native CallKit reporting for cold-killed incoming calls, server-driven cancel pushes, caller-ID cache, and the in-call audio-mode guardian.'
  s.author         = 'Connect Communications'
  s.homepage       = 'https://app.connectcomunications.com'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'RNCallKeep'
  s.dependency 'RNVoipPushNotification'

  s.source_files = '**/*.{h,m,mm,swift}'
end
