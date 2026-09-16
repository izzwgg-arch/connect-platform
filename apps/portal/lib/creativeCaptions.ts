/**
 * Creative Studio — turning a spoken script into captions.
 *
 * Its own module so it can be tested without a browser: captions that drift
 * out of sync are worse than no captions, so the splitting and the timing are
 * worth pinning down with real examples.
 */

/** Break a script into caption-sized lines the way a person reads them. */
export function captionLines(script: string, maxChars = 42): string[] {
  const sentences = String(script || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      out.push(sentence);
      continue;
    }
    let line = "";
    for (const word of sentence.split(" ")) {
      if ((line + " " + word).trim().length > maxChars) {
        if (line) out.push(line.trim());
        line = word;
      } else {
        line = `${line} ${word}`;
      }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out;
}

/** Spread lines across the spoken audio, weighted by how long each one is. */
export function captionCues(lines: string[], totalMs: number, startMs = 0): Array<{ startMs: number; endMs: number; text: string }> {
  const chars = lines.reduce((n, l) => n + Math.max(1, l.length), 0) || 1;
  let at = startMs;
  return lines.map((text) => {
    const span = Math.max(700, Math.round((Math.max(1, text.length) / chars) * totalMs));
    const cue = { startMs: at, endMs: at + span, text };
    at += span;
    return cue;
  });
}
