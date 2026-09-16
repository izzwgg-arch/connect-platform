/** Serializes real turns into the existing Assistant. Provider history updates
 * can repeat; user speech can interrupt an answer while its tools are running.
 * We never retry an assistant turn automatically (it may have performed an action).
 */
import { SpeechSentences, type SpeechOptions } from "./laybelSpeech";

export type LaybelSpeechSink = { write: (text: string) => Promise<void>; finish: () => Promise<void>; cancel: () => void };

export class LaybelTurns {
  private seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  private cancelSpeech?: () => void;
  private request?: AbortController;
  constructor(private ask: (text: string, speech?: SpeechOptions) => Promise<{ reply: string; humanTakeover?: boolean } | undefined>,
    private speak: (text: string) => Promise<void>, private failed: () => void,
    private takeover: () => void, private createSpeech?: () => LaybelSpeechSink) {}
  interrupt() { this.epoch += 1; this.cancelSpeech?.(); }
  close() { this.closed = true; this.interrupt(); this.request?.abort(); }
  submit(id: string, text: string): Promise<void> {
    if (this.closed || this.seen.has(id) || !text.trim()) return this.queue;
    this.seen.add(id);
    const epoch = this.epoch;
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
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
        const answer = await this.ask(text, this.createSpeech ? { signal: this.request.signal, onDelta: delta => {
          if (!active() || speechDone || !delta) return;
          streamed = true;
          sentences.push(delta);
        }, onDone: finishSpeech } : undefined);
        if (this.closed) return;
        if (!answer) { sink?.cancel(); this.failed(); return; }
        if (answer.humanTakeover) { this.close(); this.takeover(); return; }
        if (streamed) {
          finishSpeech();
          await writes;
          if (writeError) throw writeError;
        } else if (active() && answer.reply.trim()) await this.speak(answer.reply);
      } catch { sink?.cancel(); if (!this.closed && epoch === this.epoch) this.failed(); }
      finally { cancelled = true; this.cancelSpeech = undefined; this.request = undefined; }
    });
    return this.queue;
  }
}
