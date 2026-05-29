export function selectPlaybackChannelName(channels: string[], targetLeg: "external" | "agent"): string | null {
  const playable = channels.filter((channel) => channel && !/^Local\//i.test(channel) && !/^Message\//i.test(channel));
  const trunk = playable.find((channel) => /^PJSIP\/\d+_/i.test(channel));
  const agent = playable.find((channel) => /^PJSIP\/T\d+_\d+/i.test(channel));
  if (targetLeg === "agent") return agent || trunk || playable[0] || null;
  return trunk || playable.find((channel) => channel !== agent) || agent || playable[0] || null;
}
