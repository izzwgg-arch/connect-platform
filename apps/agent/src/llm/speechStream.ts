/** A spoken partial answer cannot be retracted or silently replaced by failover. */
export class SpeechStreamError extends Error {
  constructor() { super("The spoken answer was interrupted; the turn was not retried."); }
}

export type SpeechDelta = (text: string) => void;

/** Only explicitly final assistant text is eligible for early playback. Models
 * without a phase remain buffered: a text block can precede a tool call.
 * Return the complete response unchanged so tool replay retains every item/phase.
 */
export async function readFinalSpeech(
  events: AsyncIterable<any>, emit: SpeechDelta,
): Promise<any> {
  const finalIds = new Set<string>();
  let spoke = false;
  let sawTool = false;
  try {
    for await (const event of events) {
      if (event.type === "response.output_item.added") {
        const item = event.item;
        if (item?.type === "function_call") {
          sawTool = true;
          if (spoke) throw new SpeechStreamError();
        }
        if (!sawTool && item?.type === "message" && item.role === "assistant" && item.phase === "final_answer") finalIds.add(item.id);
      }
      if (event.type === "response.output_text.delta" && !sawTool && finalIds.has(event.item_id) && event.delta) {
        spoke = true;
        emit(event.delta);
      }
      if (event.type === "response.completed") {
        const response = event.response;
        if (!response || (spoke && response.output?.some((item: any) => item.type === "function_call"))) throw new SpeechStreamError();
        return response;
      }
      if (["response.failed", "response.incomplete", "error"].includes(event.type)) throw new Error("Model stream did not complete");
    }
    throw new Error("Model stream closed before completion");
  } catch (error) {
    if (spoke) throw new SpeechStreamError();
    throw error;
  }
}
