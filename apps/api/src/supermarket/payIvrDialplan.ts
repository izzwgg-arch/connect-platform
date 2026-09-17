/**
 * The dialplan's view of a pay-IVR step.
 *
 * Asterisk cannot loop over a JSON array, so the api hands the PBX ONE
 * ready-to-play string and one word saying what to do next. Keeping this
 * derivation here — on the server, under test — is what lets the dialplan stay
 * dumb: no business logic, no amounts, and no card handling ever live on the
 * PBX side of this feature.
 *
 * ⛔ Prompt refs are sanitised before they become a filesystem path. They come
 * from our own reducer today, but this string is handed straight to Playback()
 * on a live PBX: a ref that could carry ".." or an absolute path would be a
 * file-read primitive on the phone system. Anything but [A-Za-z0-9_] is
 * dropped, and a ref that survives as empty is dropped whole.
 */

export const PAY_PROMPT_DIR = (process.env.SUPERMARKET_PAY_PROMPT_DIR || "/var/lib/asterisk/sounds/connect-pay/en-male")
  .replace(/\/+$/, "");

export type PayIvrDialplanView = {
  /** `&`-joined absolute paths, ready for Playback()/Read() — "" when silent. */
  playback: string;
  /** What the dialplan does after playing: gather | transfer | hangup | continue. */
  action: "gather" | "transfer" | "hangup" | "continue";
  /** Digits to collect when action is "gather"; 0 otherwise. */
  maxDigits: number;
};

export function safePromptRef(ref: unknown): string | null {
  const cleaned = String(ref ?? "").replace(/[^A-Za-z0-9_]/g, "");
  return cleaned.length > 0 && cleaned.length <= 64 ? cleaned : null;
}

export function payIvrDialplanView(
  result: { prompts: string[]; gather: { maxDigits: number } | null; transfer: boolean; done: boolean },
  dir: string = PAY_PROMPT_DIR,
): PayIvrDialplanView {
  const root = String(dir || "").replace(/\/+$/, "");
  const refs = (Array.isArray(result.prompts) ? result.prompts : [])
    .map(safePromptRef)
    .filter((r): r is string => r !== null);
  const playback = refs.map((r) => `${root}/${r}`).join("&");
  // ⛔ transfer wins over done, and both win over gather: a call that is
  // finished or being handed to a person must never sit collecting digits.
  const action: PayIvrDialplanView["action"] = result.transfer
    ? "transfer"
    : result.done
      ? "hangup"
      : result.gather
        ? "gather"
        : "continue";
  const maxDigits = action === "gather" ? Math.max(1, Math.min(32, Number(result.gather?.maxDigits ?? 1))) : 0;
  return { playback, action, maxDigits };
}
