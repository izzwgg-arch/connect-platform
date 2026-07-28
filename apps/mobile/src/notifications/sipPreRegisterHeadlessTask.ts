/**
 * sipPreRegisterHeadlessTask.ts
 *
 * Registers a HeadlessJS task ("ConnectSipPreRegister") that the native
 * IncomingCallFirebaseService starts on an INCOMING_CALL push while the app is
 * terminated / swiped away.
 *
 * Why this exists
 * ---------------
 * In the fully-killed state NO JavaScript runs during the ring: the native FCM
 * service shows the call UI but never boots React Native, so the JsSIP UA can
 * only register AFTER the user answers (which finally launches MainActivity).
 * That cold registration then waits several seconds for the PBX to re-deliver
 * the INVITE — the "very long time to connect" symptom.
 *
 * This task boots the JS engine DURING the ring, registers the shared singleton
 * SIP client (see sipClientSingleton.ts), and holds the task — keeping the
 * process + WebSocket alive — until the call is answered/ended or a bounded
 * timeout. Because a HeadlessJS task and MainActivity share ONE React Native
 * process, the UA + inbound INVITE this task receives during the ring is the
 * SAME client SipContext attaches to at answer → the answer is instant.
 *
 * MUST be imported from index.js BEFORE registerRootComponent so the task name
 * is registered before the native service tries to start it.
 */
import { AppRegistry } from 'react-native';

import { logCallFlow } from '../debug/callFlowDebug';

/** Native HeadlessJsTaskService.getTaskConfig() must use this exact name. */
export const SIP_PREREGISTER_TASK = 'ConnectSipPreRegister';

/**
 * Max time to keep the headless task (and thus the process + WebSocket) alive
 * through the ring. PSTN/SIP callers abandon at ~25-35s; we hold just under the
 * native HeadlessJsTaskConfig timeout (35s) so RN tears us down cleanly.
 */
const MAX_HOLD_MS = 30_000;
const POLL_MS = 750;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

AppRegistry.registerHeadlessTask(
  SIP_PREREGISTER_TASK,
  () => async (taskData?: Record<string, any>) => {
    const inviteId = String(taskData?.inviteId || taskData?.callId || '');
    const mode = String(taskData?.mode || '');
    const startedAt = Date.now();
    logCallFlow('SIP_PREREGISTER_TASK_START', { inviteId: inviteId || null, extra: { mode: mode || null } });

    try {
      // Lazy-require so the heavy SIP/WebRTC module graph is only pulled in when
      // a call actually arrives (keeps the cold index.js load light).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const singleton = require('../sip/sipClientSingleton') as typeof import('../sip/sipClientSingleton');

      // ── Standing-registration maintenance tick ────────────────────────────
      // Dispatched by SipKeepAliveService's heartbeat (server flag gated,
      // never while a call is active on the native side). Job: put a real
      // REGISTER on the wire, then get out — no 30s ring-hold. This must NOT
      // be a soft no-op on isRegistered(): Android freezes JS timers in the
      // background, so the client's registered belief goes stale while the
      // PBX expires the contact (see headlessMaintenanceRegisterSip).
      if (mode === 'maintenance') {
        if (singleton.hasActiveSipSession()) {
          logCallFlow('SIP_MAINT_REGISTER_SKIP_ACTIVE_SESSION', { inviteId: null });
          return;
        }
        const ok = await singleton.headlessMaintenanceRegisterSip();
        logCallFlow('SIP_MAINT_REGISTER_RESULT', {
          inviteId: null,
          extra: { registered: ok, sinceStartMs: Date.now() - startedAt },
        });
        return;
      }

      const registered = await singleton.headlessPreRegisterSip();
      logCallFlow('SIP_PREREGISTER_RESULT', {
        inviteId: inviteId || null,
        extra: { registered, sinceStartMs: Date.now() - startedAt },
      });

      if (!registered) {
        // No provisioning (signed out) or register failed — nothing to hold for.
        return;
      }

      // Hold the process + WebSocket alive through the ring so the inbound
      // INVITE lands on this UA and survives until the user answers (which
      // mounts SipContext on the same singleton). Exit early once a session
      // appears and then disappears (caller hung up / call canceled during the
      // ring) so we don't pin the process needlessly.
      let sawSession = false;
      while (Date.now() - startedAt < MAX_HOLD_MS) {
        await sleep(POLL_MS);
        const active = singleton.hasActiveSipSession();
        if (active) {
          sawSession = true;
        } else if (sawSession) {
          break;
        }
      }
      logCallFlow('SIP_PREREGISTER_TASK_END', {
        inviteId: inviteId || null,
        extra: { sawSession, heldMs: Date.now() - startedAt },
      });
    } catch (e: any) {
      logCallFlow('SIP_PREREGISTER_TASK_ERROR', {
        inviteId: inviteId || null,
        extra: { message: e?.message || String(e) },
      });
    }
  },
);
