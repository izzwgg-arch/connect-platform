/**
 * JS-thread stall watchdog + bridge flight recorder (diagnostic).
 *
 * Purpose: catch the "taps do nothing for seconds" freezes in RELEASE builds
 * with proof instead of guesses. A silent JS-thread stall leaves no system
 * logs (no ANR, no Choreographer skips, no JS logs — verified 2026-07-28), so
 * the thread must measure itself:
 *
 *  1. Heartbeat: a 250ms interval measures scheduling drift. Drift > 400ms
 *     means the JS thread was blocked that long → logs `[JS_LAG] blocked=Xms`.
 *  2. Bridge spy: records the last BRIDGE_RING native<->JS calls (module.method
 *     + timestamp) in a ring buffer. On a lag event the tail is dumped —
 *     whatever ran right before the gap is the blocker (sync native calls,
 *     huge JSON parses, storms of bridge traffic).
 *
 * Overhead: the spy adds a tiny closure per bridge call and the heartbeat is
 * one timer — fine for diagnosis; remove or gate once the freeze is fixed.
 */
import { Platform } from 'react-native';

type BridgeCall = { t: number; dir: string; name: string };

const BRIDGE_RING = 120;
const HEARTBEAT_MS = 250;
const LAG_THRESHOLD_MS = 400;

let installed = false;

export function installJsLagWatchdog(): void {
  if (installed || Platform.OS === 'web') return;
  installed = true;

  const ring: BridgeCall[] = [];
  let ringIdx = 0;

  // Resolve numeric bridge module/method ids to names. Release builds pass
  // ids to the spy; the bridge config still carries the name table.
  const moduleTable: Record<string, { name: string; methods: string[] }> = {};
  try {
    const cfg = (global as any).__fbBatchedBridgeConfig?.remoteModuleConfig;
    if (Array.isArray(cfg)) {
      cfg.forEach((m: any, i: number) => {
        if (Array.isArray(m) && typeof m[0] === 'string') {
          moduleTable[String(i)] = { name: m[0], methods: Array.isArray(m[2]) ? m[2] : [] };
        }
      });
    }
  } catch { /* names stay numeric */ }
  const resolveName = (module: unknown, method: unknown): string => {
    const mod = moduleTable[String(module)];
    if (!mod) return `${module}.${method}`;
    const methodName = typeof method === 'number' ? mod.methods[method] ?? method : method;
    return `${mod.name}.${methodName}`;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const MessageQueue = require('react-native/Libraries/BatchedBridge/MessageQueue');
    MessageQueue.spy((info: { type: number; module?: string; method?: string; args?: unknown[] }) => {
      let name = resolveName(info.module ?? '?', info.method ?? '?');
      // UI events all arrive as RCTEventEmitter.receiveEvent(viewTag, eventName,
      // payload) — append the event name so a flood identifies itself
      // (topScroll vs topLayout vs topTouchMove ...).
      if (name.indexOf('receiveEvent') !== -1 && Array.isArray(info.args) && typeof info.args[1] === 'string') {
        name += ':' + info.args[1];
      }
      const entry: BridgeCall = {
        t: Date.now(),
        dir: info.type === 0 ? 'N->JS' : 'JS->N',
        name,
      };
      if (ring.length < BRIDGE_RING) ring.push(entry);
      else {
        ring[ringIdx] = entry;
        ringIdx = (ringIdx + 1) % BRIDGE_RING;
      }
    });
    console.log('[JS_LAG] watchdog installed (bridge spy active)');
  } catch (e) {
    console.log('[JS_LAG] watchdog installed (bridge spy unavailable: ' + String(e) + ')');
  }

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - last - HEARTBEAT_MS;
    last = now;
    if (drift > LAG_THRESHOLD_MS) {
      const stallStart = now - drift;
      // Dump the ring tail: calls in the 2s before the stall began, plus any
      // that landed during it. Chronological order.
      const window = ring
        .slice()
        .sort((a, b) => a.t - b.t)
        .filter((c) => c.t >= stallStart - 2000);
      // Aggregate: counts per call name tell the story better than a raw tail.
      const counts: Record<string, number> = {};
      for (const c of window) counts[`${c.dir} ${c.name}`] = (counts[`${c.dir} ${c.name}`] ?? 0) + 1;
      const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([n, k]) => `${k}x ${n}`);
      console.warn(
        `[JS_LAG] blocked=${drift}ms stallStartTs=${new Date(stallStart).toISOString()} windowCalls=${window.length} top=` +
          JSON.stringify(top),
      );
    }
  }, HEARTBEAT_MS);
}
