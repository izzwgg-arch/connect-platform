import type { TelephonyHealth, ConnectionHealth, AriHealth } from "../types";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import type { CallStateStore } from "../state/CallStateStore";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import { env } from "../../config/env";

export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly ami: AmiClient,
    private readonly ari: AriClient,
    private readonly calls: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
  ) {}

  getHealth(): TelephonyHealth {
    const amiHealth = this.amiConnectionHealth();
    const ariHealth = this.ariRestHealth();

    // System is "ok" if AMI is connected (AMI is the canonical event source).
    // ARI REST unavailability degrades but does not bring the system down since
    // AMI carries all event data.
    let status: TelephonyHealth["status"];
    if (amiHealth.connected && ariHealth.restHealthy) {
      status = "ok";
    } else if (amiHealth.connected) {
      status = "degraded"; // ARI REST unreachable but AMI is fine
    } else {
      status = "down"; // AMI down — no event feed
    }

    return {
      status,
      ami: amiHealth,
      ari: ariHealth,
      activeCalls: this.calls.getActive().length,
      activeExtensions: this.extensions.getAll().length,
      activeQueues: this.queues.getAll().length,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      pbxHost: env.PBX_HOST,
    };
  }

  private amiConnectionHealth(): ConnectionHealth {
    return {
      connected: this.ami._isConnected,
      lastEventAt: this.ami.lastEventAt?.toISOString() ?? null,
      reconnectCount: 0,
      lastError: this.ami.lastError,
    };
  }

  private ariRestHealth(): AriHealth {
    return {
      restHealthy: this.ari._isConnected,
      webSocketSupported: false,
      lastCheckAt: this.ari.lastRestCheckAt?.toISOString() ?? null,
      lastError: this.ari.lastError,
    };
  }
}
