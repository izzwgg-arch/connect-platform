export type DeployPollResult = "ok" | "retry" | "stop";
type Environment = {
  visible: () => boolean;
  schedule: (fn: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
  onVisible: (fn: () => void) => () => void;
};

/** Sequential, visibility-aware polling: slow requests never overlap. */
export function startDeployPolling(poll: () => Promise<DeployPollResult>, env: Environment) {
  let stopped = false;
  let inFlight = false;
  let timer: unknown;
  const clear = () => { if (timer !== undefined) env.cancel(timer); timer = undefined; };
  const tick = async () => {
    if (stopped || inFlight || !env.visible()) return;
    clear();
    inFlight = true;
    let result: DeployPollResult = "retry";
    try { result = await poll(); } catch { /* Back off unexpected failures too. */ }
    inFlight = false;
    if (result === "stop") stopped = true;
    if (!stopped && env.visible()) timer = env.schedule(() => { void tick(); }, result === "retry" ? 30_000 : 10_000);
  };
  const unsubscribe = env.onVisible(() => {
    clear();
    if (env.visible()) void tick();
  });
  void tick();
  return () => { stopped = true; clear(); unsubscribe(); };
}

export function deployPollFailure(error: unknown): DeployPollResult {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return status === 401 || status === 403 || status === 404 ? "stop" : "retry";
}
