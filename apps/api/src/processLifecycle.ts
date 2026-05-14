/**
 * Process-wide readiness + shutdown timer bookkeeping for graceful SIGTERM handling.
 */

const shutdownTimers: NodeJS.Timeout[] = [];

/** When false, GET /ready returns 503 immediately (during drain). */
let acceptingTraffic = false;

/** Set once listen() resolves — readiness probe also checks DB. */
export let serverListeningCompleted = false;

export function registerShutdownTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  shutdownTimers.push(timer);
  return timer;
}

export function markListeningComplete(): void {
  serverListeningCompleted = true;
  acceptingTraffic = true;
}

export function isReadyToServeTraffic(): boolean {
  return acceptingTraffic && serverListeningCompleted;
}

/** First phase of SIGTERM: stop marking /ready as healthy; keep handling in-flight work. */
export function markNotAcceptingTraffic(): void {
  acceptingTraffic = false;
}

export function clearRegisteredShutdownTimers(): void {
  for (const t of shutdownTimers) {
    try {
      clearInterval(t);
    } catch {}
    try {
      clearTimeout(t);
    } catch {}
  }
  shutdownTimers.length = 0;
}

export function shutdownRegisteredTimerCount(): number {
  return shutdownTimers.length;
}
