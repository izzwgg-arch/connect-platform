// webhookExecutor — fires a generic HTTP action for menu items that target
// systems other than Home Assistant. Same error taxonomy as the HA client so
// the IVR handles both uniformly.

import { HaError } from "./HomeAssistantClient";
import type { SmartHomeWebhook } from "./config";

export async function executeWebhook(hook: SmartHomeWebhook, timeoutMs = 5000): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const hasBody = hook.method !== "GET" && hook.body !== undefined;
    const res = await fetch(hook.url, {
      method: hook.method,
      signal: ac.signal,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(hook.headers ?? {}),
      },
      body: hasBody ? JSON.stringify(hook.body) : undefined,
    });
    if (res.status === 401 || res.status === 403) {
      throw new HaError("auth", `webhook rejected auth (${res.status})`);
    }
    if (!res.ok) {
      throw new HaError("service", `webhook returned ${res.status}`);
    }
  } catch (err) {
    if (err instanceof HaError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new HaError("timeout", `webhook timed out after ${timeoutMs}ms`);
    }
    throw new HaError("unreachable", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
