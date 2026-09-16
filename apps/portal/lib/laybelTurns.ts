/** Serializes real turns into the existing Assistant. Provider history updates
 * can repeat; user speech can interrupt an answer while its tools are running.
 * We never retry an assistant turn automatically (it may have performed an action).
 */
export class LaybelTurns {
  private seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  constructor(private ask: (text: string) => Promise<{ reply: string; humanTakeover?: boolean } | undefined>,
    private speak: (text: string) => Promise<void>, private failed: () => void,
    private takeover: () => void) {}
  interrupt() { this.epoch += 1; }
  close() { this.closed = true; this.interrupt(); }
  submit(id: string, text: string): Promise<void> {
    if (this.closed || this.seen.has(id) || !text.trim()) return this.queue;
    this.seen.add(id);
    const epoch = this.epoch;
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        const answer = await this.ask(text);
        if (this.closed) return;
        if (!answer) { this.failed(); return; }
        if (answer.humanTakeover) { this.close(); this.takeover(); return; }
        if (epoch === this.epoch && answer.reply.trim()) await this.speak(answer.reply);
      } catch { if (!this.closed) this.failed(); }
    });
    return this.queue;
  }
}
