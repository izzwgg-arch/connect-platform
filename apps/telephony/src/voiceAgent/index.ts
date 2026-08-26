/**
 * Voice-agent module wiring — ARMED ONLY when VOICE_AGENT_ENABLED=1.
 *
 * With the flag off (the default), startVoiceAgent() returns null without
 * opening a port, registering an AMI listener, or touching anything: the
 * telephony service is byte-for-byte the service it was before this module
 * existed. That off-state is the deploy-safety property — the first telephony
 * deploy carrying this code changes nothing until the env flag is set.
 *
 * ⛔ NOTHING in here may reach into CallStateStore, the wake machinery, or
 * any other telephony service. The module's whole world is: the AMI event
 * stream (read-only listener for ConnectVoiceAgent UserEvents + DBPut for the
 * transfer flag), its own TCP port, and the api's /internal/voice-agent doors.
 */

import { childLogger } from "../logging/logger";
import { parseVoiceAgentAnnouncement, type AmiFrameLike } from "./voiceAgentEvents";
import { VoiceAgentServer } from "./VoiceAgentServer";

const log = childLogger("VoiceAgent");

export interface VoiceAgentAmiLike {
  on(event: "event", listener: (frame: AmiFrameLike) => void): unknown;
  dbPut(family: string, key: string, value: string, timeoutMs?: number): Promise<unknown>;
}

export function voiceAgentEnabled(envRecord: NodeJS.ProcessEnv = process.env): boolean {
  return String(envRecord.VOICE_AGENT_ENABLED ?? "").trim() === "1";
}

export function startVoiceAgent(ami: VoiceAgentAmiLike): VoiceAgentServer | null {
  if (!voiceAgentEnabled()) {
    return null;
  }
  const port = Number(process.env.VOICE_AGENT_PORT ?? "4590");
  const maxConcurrent = Number(process.env.VOICE_AGENT_MAX_SESSIONS ?? "8");
  const server = new VoiceAgentServer({
    port: Number.isFinite(port) && port > 0 ? port : 4590,
    maxConcurrentSessions: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 8,
    dbPut: (family, key, value) => ami.dbPut(family, key, value),
  });

  ami.on("event", (frame) => {
    try {
      const ann = parseVoiceAgentAnnouncement(frame);
      if (ann) server.announce(ann);
    } catch (err) {
      log.warn({ err: String(err) }, "voice-agent: announcement handler error");
    }
  });

  server.start();
  return server;
}
