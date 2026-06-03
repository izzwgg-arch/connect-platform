/**
 * Asterisk-compatible WebRTC audio constraints for mobile SIP calls.
 * Avoid strict channelCount / sampleRate hints that can trigger 488 Incompatible SDP.
 */

export type VoiceMediaConstraints = {
  audio: MediaTrackConstraints | boolean;
  video: boolean;
};

/** Broad voice profile — AEC/NS/AGC only; let PBX negotiate codec/rate. */
export function buildVoiceAudioConstraints(): VoiceMediaConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };
}
