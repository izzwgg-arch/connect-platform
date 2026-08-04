/**
 * Starting voice settings for IVR greetings.
 *
 * Lives here rather than in the page because a Next.js page file may only
 * export a default component and a handful of reserved names — exporting a
 * constant from one fails the production build with "does not match the
 * required types of a Next.js Page", which `tsc` does not catch.
 *
 * A greeting is heard by someone waiting to be helped, often on a poor line,
 * so it wants to be steady and identical every time rather than expressive:
 *   - high stability      keeps it consistent between renders
 *   - style 0             avoids theatrical delivery, and costs no extra latency
 *   - speed just under 1  gives people time to take in the options
 * A starting point to tune by ear, not gospel.
 */
export const VOICE_PRESET = {
  stability: 0.75,
  similarity_boost: 0.8,
  style: 0,
  use_speaker_boost: true,
  speed: 0.95,
} as const;
