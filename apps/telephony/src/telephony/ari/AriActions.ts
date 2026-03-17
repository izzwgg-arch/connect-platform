import { childLogger } from "../../logging/logger";
import type { AriClient } from "./AriClient";
import type { AriOriginateParams, AriChannel, AriBridge } from "./AriTypes";

const log = childLogger("AriActions");

// High-level action wrappers around AriClient REST calls.
// All methods are guarded and log the action before execution.

export class AriActions {
  constructor(private readonly ari: AriClient) {}

  async getChannels(): Promise<AriChannel[]> {
    return this.ari.getChannels();
  }

  async getBridges(): Promise<AriBridge[]> {
    return this.ari.getBridges();
  }

  async hangupChannel(channelId: string): Promise<void> {
    log.info({ channelId }, "ARI hangup channel");
    await this.ari.hangupChannel(channelId);
  }

  async createBridge(type?: string): Promise<AriBridge> {
    log.info({ type }, "ARI create bridge");
    return this.ari.createBridge(type);
  }

  async addChannelToBridge(bridgeId: string, channelId: string): Promise<void> {
    log.info({ bridgeId, channelId }, "ARI add channel to bridge");
    await this.ari.addChannelToBridge(bridgeId, channelId);
  }

  async removeChannelFromBridge(bridgeId: string, channelId: string): Promise<void> {
    log.info({ bridgeId, channelId }, "ARI remove channel from bridge");
    await this.ari.removeChannelFromBridge(bridgeId, channelId);
  }

  async originate(params: AriOriginateParams): Promise<AriChannel> {
    log.info({ endpoint: params.endpoint }, "ARI originate call");
    const body: Record<string, unknown> = {
      endpoint: params.endpoint,
      app: params.app ?? "connectcomms",
    };
    if (params.callerId) body["callerId"] = params.callerId;
    if (params.timeout !== undefined) body["timeout"] = params.timeout;
    if (params.variables) body["variables"] = params.variables;
    if (params.appArgs) body["appArgs"] = params.appArgs;
    if (params.extension) body["extension"] = params.extension;
    if (params.context) body["context"] = params.context;
    if (params.priority !== undefined) body["priority"] = params.priority;
    return this.ari.rest<AriChannel>("POST", "/ari/channels", body);
  }

  // ── Placeholders requiring PBX-side dialplan / channel-var configuration ───

  // TODO: Implement snoop channel for whisper/barge. Requires the snoopChannel
  // ARI endpoint and PBX-side SNOOPABLE channel variable. Do NOT implement
  // without auditing the VitalPBX dialplan for snoop ACLs first.
  async whisperChannel(_channelId: string, _audioUrl: string): Promise<void> {
    throw new Error(
      "whisperChannel is not yet implemented. " +
        "ARI snoop must be validated against the VitalPBX dialplan ACL.",
    );
  }

  // TODO: Barge requires a conference/bridge join without mute. Confirm
  // recording-law compliance before enabling.
  async bargeCall(_bridgeId: string): Promise<void> {
    throw new Error(
      "bargeCall is not yet implemented. " +
        "Compliance review required before enabling barge.",
    );
  }

  // TODO: Monitor / recording placeholders — ARI record endpoint works but
  // file storage path must be configured on the PBX and mirrored to the app.
  async startRecording(_channelId: string, _filename: string): Promise<void> {
    throw new Error(
      "startRecording is not yet implemented. " +
        "Configure recordingDir on the PBX and restart the service.",
    );
  }

  async stopRecording(_recordingName: string): Promise<void> {
    throw new Error("stopRecording is not yet implemented.");
  }
}
