/**
 * Portal WebRTC SDP diagnostics — re-exports shared black-box helpers.
 * Legacy imports from this path remain valid for portal code and tests.
 */
export {
  SDP_REJECT_SIP_CODES,
  summarizeOfferSdp,
  checkOfferCompatibility,
  redactSdpForDebug,
  isWebrtcSdpRejection,
  sdpRejectionLabel,
  webrtcSdpDebugEnabled,
  WEBRTC_BLACKBOX_SCHEMA_VERSION,
  WEBRTC_BLACKBOX_PAYLOAD_VERSION,
  type SdpOfferSummary,
} from "@connect/shared/webrtcBlackbox";
