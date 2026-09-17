/**
 * The keyed-card vault for the pay line — PROCESS MEMORY ONLY (2026-09-17).
 *
 * A caller keys a card in the AGI; it reaches the api's card door; it is
 * charged (or stored on the register) a few seconds later on a different HTTP
 * request. Between those two requests the card has to live somewhere, and
 * that somewhere is this Map — never the session row, never Redis, never a
 * log. Entries die on charge, on hangup, and after CARD_VAULT_TTL_MS.
 *
 * Consequences, accepted on purpose:
 * - an api restart / blue-green deploy between the two requests loses the
 *   card; the caller is asked to key it again (the reducer's card_entry cap
 *   bounds that);
 * - the vault is per api process; the pay line runs on the one api container
 *   (nginx pins the pay door to the active api).
 * ⛔ Nothing here may ever be JSON.stringify'd into a log line. The only thing
 *    that leaves this module besides the card itself is a last-four string.
 */

import type { PosKeyedCard } from "./posWithLogic";

export const CARD_VAULT_TTL_MS = 15 * 60 * 1000;

type Entry = { card: PosKeyedCard; at: number };

const vault = new Map<string, Entry>();

function sweep(now: number) {
  for (const [k, v] of vault) if (now - v.at > CARD_VAULT_TTL_MS) vault.delete(k);
}

/** Store the card for this session row id. Overwrites an earlier entry (re-keyed card). */
export function vaultPut(sessionId: string, card: PosKeyedCard, now: number = Date.now()): void {
  sweep(now);
  vault.set(sessionId, { card, at: now });
}

/** The card for this session, or null (never stored, expired, or already used). */
export function vaultGet(sessionId: string, now: number = Date.now()): PosKeyedCard | null {
  sweep(now);
  const e = vault.get(sessionId);
  return e ? e.card : null;
}

export function vaultDelete(sessionId: string): void {
  vault.delete(sessionId);
}

/** Tests only. */
export function vaultSize(): number {
  return vault.size;
}

/** "…1234" for prompts and desk rows — the only card-derived string that may be persisted. */
export function cardLast4(card: PosKeyedCard): string {
  const d = String(card.number ?? "").replace(/\D/g, "");
  return d.slice(-4);
}
