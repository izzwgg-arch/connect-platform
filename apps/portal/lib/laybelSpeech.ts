export type LaybelAnswer = { conversationId: string; reply: string; humanTakeover?: boolean };
export type SpeechOptions = { onDelta: (text: string) => void; onDone: () => void; signal?: AbortSignal };

/** Single-request compatibility with older agents; never retry a tool-bearing POST. */
export async function readLaybelAnswer(response: Response, onDelta: (text: string) => void, onDone: () => void = () => {}): Promise<LaybelAnswer> {
  if (!response.ok) throw new Error(`Assistant request failed: ${response.status}`);
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) return response.json();
  if (!response.body) throw new Error("Assistant stream missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const line = (value: string): LaybelAnswer | undefined => {
    if (!value.trim()) return;
    const event = JSON.parse(value);
    if (event.type === "error") throw new Error("Assistant stream interrupted");
    if (event.type === "speech" && typeof event.text === "string") onDelta(event.text);
    if (event.type === "speech_end") onDone();
    if (event.type === "complete") {
      if (typeof event.result?.reply !== "string" || typeof event.result?.conversationId !== "string") throw new Error("Invalid assistant answer");
      return event.result;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 1_000_000) throw new Error("Assistant stream exceeded limit");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const answer = line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (answer) return answer;
      }
      if (done) {
        const answer = line(buffer);
        if (answer) return answer;
        throw new Error("Assistant stream closed before completion");
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Complete sentences only; decimal points/short initials are not boundaries.
 * The final unfinished sentence is flushed when the authenticated turn completes.
 */
export class SpeechSentences {
  private pending = "";
  constructor(private emit: (sentence: string) => void) {}
  push(text: string) {
    this.pending += text;
    const boundary = /[!?](?:["')\]]*)\s+|\.(?:["')\]]*)\s+/g;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.pending))) {
      const end = match.index + match[0].length;
      const sentence = this.pending.slice(0, end);
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|[A-Z])\.\s+$/i.test(sentence)) continue;
      this.emit(sentence);
      this.pending = this.pending.slice(end);
      boundary.lastIndex = 0;
    }
  }
  finish() { if (this.pending.trim()) this.emit(this.pending); this.pending = ""; }
}
