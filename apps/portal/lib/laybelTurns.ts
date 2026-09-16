/** Serializes real turns into the existing Assistant. Provider history updates
 * can repeat; user speech can interrupt an answer while its tools are running.
 * We never retry an assistant turn automatically (it may have performed an action).
 */
import { SpeechSentences, type SpeechOptions, type VoiceInput } from "./laybelSpeech";

export type LaybelSpeechSink = { write: (text: string) => Promise<void>; finish: () => Promise<void>; cancel: () => void };

export class LaybelTurns {
  private seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  private cancelSpeech?: () => void;
  private request?: AbortController;
  private pending = 0;
  constructor(private ask: (text: string, speech?: SpeechOptions, language?: VoiceInput["language"]) => Promise<{ reply: string; spokenReply?: string; humanTakeover?: boolean } | undefined>,
    private speak: (text: string) => Promise<void>, private failed: (error?: unknown) => void,
    private takeover: () => void, private createSpeech?: () => LaybelSpeechSink) {}
  interrupt() { this.epoch += 1; this.cancelSpeech?.(); }
  close() { this.closed = true; this.interrupt(); this.request?.abort(); }
  submit(id: string, input: string | ((signal: AbortSignal) => Promise<VoiceInput>)): Promise<void> {
    if (this.closed || this.seen.has(id) || (typeof input === "string" && !input.trim())) return this.queue;
    if (this.pending >= 3) { this.failed(); return this.queue; }
    this.pending++;
    this.seen.add(id);
    const epoch = this.epoch;
    this.queue = this.queue.then(async () => {
      if (this.closed) { this.pending--; return; }
      let sink: LaybelSpeechSink | undefined;
      let streamed = false;
      let speechDone = false;
      let cancelled = false;
      let writeError: unknown;
      let writes = Promise.resolve();
      const active = () => !this.closed && !cancelled && epoch === this.epoch;
      this.cancelSpeech = () => { cancelled = true; sink?.cancel(); };
      const sentences = new SpeechSentences(sentence => {
        writes = writes.then(async () => {
          if (!active() || writeError) return;
          sink ??= this.createSpeech!();
          await sink.write(sentence);
        }).catch(error => { writeError = error; sink?.cancel(); });
      });
      const finishSpeech = () => {
        if (speechDone) return;
        speechDone = true;
        sentences.finish();
        writes = writes.then(async () => { if (active() && !writeError) await sink?.finish(); }).catch(error => { writeError = error; sink?.cancel(); });
      };
      this.request = new AbortController();
      try {
        const turn = typeof input === "string" ? { text: input } : await input(this.request.signal);
        if (this.closed || !turn.text.trim()) return;
        const answer = await this.ask(turn.text, this.createSpeech ? { signal: this.request.signal, onDelta: delta => {
          if (!active() || speechDone || !delta) return;
          streamed = true;
          sentences.push(delta);
        }, onDone: finishSpeech } : undefined, turn.language);
        if (this.closed) return;
        if (!answer) { sink?.cancel(); this.failed(); return; }
        if (answer.humanTakeover) { this.close(); this.takeover(); return; }
        if (streamed) {
          finishSpeech();
          await writes;
          if (writeError) throw writeError;
        } else if (active() && (answer.spokenReply ?? answer.reply).trim()) await this.speak(answer.spokenReply ?? answer.reply);
      } catch (error) { sink?.cancel(); if (!this.closed && epoch === this.epoch) this.failed(error); }
      finally { this.pending--; cancelled = true; this.cancelSpeech = undefined; this.request = undefined; }
    });
    return this.queue;
  }
}
