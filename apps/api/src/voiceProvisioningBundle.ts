/** WebRTC/mobile SIP identity fields from a PbxExtensionLink row. */
export type WebrtcPbxLinkIdentity = {
  pbxSipUsername?: string | null;
  pbxDeviceName?: string | null;
};

/**
 * Resolve SIP URI + digest auth usernames for WebRTC/mobile provisioning.
 * VitalPBX WebRTC endpoints register against the device name (e.g. T25_101_1),
 * not the shorter device user field (e.g. 101_1). When pbxDeviceName is present,
 * both sipUsername and authUsername must use it so JsSIP From/To matches the PBX AOR.
 */
export function resolveWebrtcSipIdentity(pbxLink: WebrtcPbxLinkIdentity): {
  sipUsername: string;
  authUsername: string;
} {
  const deviceName = String(pbxLink.pbxDeviceName ?? "").trim();
  const sipUser = String(pbxLink.pbxSipUsername ?? "").trim();
  const identity = deviceName || sipUser;
  return { sipUsername: identity, authUsername: identity };
}

export type VoiceProvisioningBundle = {
  sipUsername: string;
  authUsername: string;
  sipPassword: string | null;
  sipWsUrl: string;
  sipDomain: string;
  outboundProxy: string | null;
  iceServers: unknown[];
  dtmfMode: string;
};

export function buildVoiceProvisioningBundleFromIdentity(
  webrtcCfg: {
    sipWsUrl: string;
    sipDomain: string;
    outboundProxy: string | null;
    iceServers: unknown[];
    dtmfMode: string;
  },
  pbxLink: WebrtcPbxLinkIdentity,
  sipPassword: string | null,
): VoiceProvisioningBundle {
  const { sipUsername, authUsername } = resolveWebrtcSipIdentity(pbxLink);
  return {
    sipUsername,
    authUsername,
    sipPassword,
    sipWsUrl: webrtcCfg.sipWsUrl,
    sipDomain: webrtcCfg.sipDomain,
    outboundProxy: webrtcCfg.outboundProxy,
    iceServers: webrtcCfg.iceServers,
    dtmfMode: webrtcCfg.dtmfMode,
  };
}

/** JsSIP/AOR URI helper for tests and diagnostics. */
export function webrtcSipUri(sipDomain: string, pbxLink: WebrtcPbxLinkIdentity): string {
  const { sipUsername } = resolveWebrtcSipIdentity(pbxLink);
  return `sip:${sipUsername}@${sipDomain}`;
}
