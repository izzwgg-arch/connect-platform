// Telephony module barrel — instantiates and wires all sub-systems.
// Import this once at startup and call start() / stop().

import http from "http";
import { env } from "../config/env";
import { childLogger } from "../logging/logger";
import { AmiClient } from "./ami/AmiClient";
import { AriClient } from "./ari/AriClient";
import { AriActions } from "./ari/AriActions";
import { CallStateStore } from "./state/CallStateStore";
import { ExtensionStateStore } from "./state/ExtensionStateStore";
import { QueueStateStore } from "./state/QueueStateStore";
import { TelephonyService } from "./services/TelephonyService";
import { HealthService } from "./services/HealthService";
import { SnapshotService } from "./services/SnapshotService";
import { TelephonySocketServer } from "./websocket/TelephonySocketServer";
import { TelephonyBroadcaster } from "./websocket/TelephonyBroadcaster";
import { CdrNotifier } from "./services/CdrNotifier";
import { AriBridgedActivePoller } from "./ari/AriBridgedActivePoller";

export type TelephonyModule = ReturnType<typeof createTelephonyModule>;

const log = childLogger("Telephony");

export function createTelephonyModule(server: http.Server) {
  const ami = new AmiClient({
    host: env.PBX_HOST,
    port: env.AMI_PORT,
    username: env.AMI_USERNAME,
    password: env.AMI_PASSWORD,
    debugFrames: env.ENABLE_TELEPHONY_DEBUG,
  });

  const ari = new AriClient({
    baseUrl: env.ARI_BASE_URL,
    username: env.ARI_USERNAME,
    password: env.ARI_PASSWORD,
    appName: env.ARI_APP_NAME,
  });

  const callStore = new CallStateStore();
  const extStore = new ExtensionStateStore();
  const queueStore = new QueueStateStore();

  const telephonyService = new TelephonyService(ami, ari, callStore, extStore, queueStore);
  const ariBridgedPoller = new AriBridgedActivePoller(ari);
  const healthService = new HealthService(ami, ari, callStore, extStore, queueStore, ariBridgedPoller);

  // CDR notifier: listens for completed calls and POSTs to the API for DB persistence.
  const cdrNotifier = new CdrNotifier();
  callStore.on("callUpsert", (call) => {
    if (call.state === "hungup") {
      cdrNotifier.notify(call);
    }
  });
  const snapshotService = new SnapshotService(callStore, extStore, queueStore, healthService, ariBridgedPoller);
  const socketServer = new TelephonySocketServer(server, snapshotService);
  const broadcaster = new TelephonyBroadcaster(
    socketServer,
    ariBridgedPoller,
    extStore,
    queueStore,
    healthService,
  );
  const ariActions = new AriActions(ari);

  function start() {
    log.info("Starting telephony module");
    ami.start();
    ari.start();
    ariBridgedPoller.start();
  }

  function stop() {
    log.info("Stopping telephony module");
    broadcaster.stop();
    ariBridgedPoller.stop();
    socketServer.close();
    ami.stop();
    ari.stop();
  }

  return {
    ami,
    ari,
    ariBridgedPoller,
    ariActions,
    telephonyService,
    healthService,
    snapshotService,
    socketServer,
    broadcaster,
    callStore,
    extStore,
    queueStore,
    start,
    stop,
  };
}
